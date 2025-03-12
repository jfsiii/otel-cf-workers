import { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { Initialiser, setConfig } from '../config'
import { exportSpans, proxyExecutionContext } from './common'
import { Exception, SpanKind, SpanOptions, SpanStatusCode, context as api_context, trace } from '@opentelemetry/api'
import { wrap } from '../wrap'
import {
	gatherIncomingCfAttributes,
	gatherRequestAttributes,
	gatherResponseAttributes,
	getParentContextFromRequest,
} from './fetch'
import {
	ATTR_FAAS_COLDSTART,
	ATTR_FAAS_INVOCATION_ID,
	ATTR_FAAS_TRIGGER,
} from '@opentelemetry/semantic-conventions/incubating'
import { versionAttributes } from './version.js'
import { instrumentEnv } from './env.js'

type PageHandlerArgs = Parameters<PagesFunction>

let cold_start = true
export function executePageHandler(pagesFn: PagesFunction, [eventContext]: PageHandlerArgs): Promise<Response> {
	const spanContext = getParentContextFromRequest(eventContext.request)

	const tracer = trace.getTracer('pagesHandler')
	const attributes = {
		[ATTR_FAAS_TRIGGER]: 'http',
		[ATTR_FAAS_COLDSTART]: cold_start,
		[ATTR_FAAS_INVOCATION_ID]: eventContext.request.headers.get('cf-ray') ?? undefined,
	}
	cold_start = false
	Object.assign(attributes, gatherRequestAttributes(eventContext.request))
	Object.assign(attributes, gatherIncomingCfAttributes(eventContext.request))
	Object.assign(attributes, versionAttributes(eventContext.env))
	const options: SpanOptions = {
		attributes,
		kind: SpanKind.SERVER,
	}

	const promise = tracer.startActiveSpan(
		`fetchHandler ${eventContext.request.method} ${eventContext.functionPath}`,
		options,
		spanContext,
		async (span) => {
			const readable = span as unknown as ReadableSpan
			try {
				const response: Response = await pagesFn(eventContext)
				span.setAttributes(gatherResponseAttributes(response))
				if (readable.attributes['http.route']) {
					span.updateName(`fetchHandler ${eventContext.request.method} ${readable.attributes['http.route']}`)
				}
				span.end()

				return response
			} catch (error) {
				if (readable.attributes['http.route']) {
					span.updateName(`fetchHandler ${eventContext.request.method} ${readable.attributes['http.route']}`)
				}
				span.recordException(error as Exception)
				span.setStatus({ code: SpanStatusCode.ERROR })
				span.end()
				throw error
			}
		},
	)
	return promise
}

export function createPageHandler<
	E = unknown,
	P extends string = any,
	D extends Record<string, unknown> = Record<string, unknown>,
>(pageFn: PagesFunction<E, P, D>, initialiser: Initialiser): PagesFunction<E, P, D> {
	const pagesHandler: ProxyHandler<PagesFunction> = {
		apply: async (target, _thisArg, argArray: Parameters<PagesFunction>): Promise<Response> => {
			const [orig_ctx] = argArray
			const env = instrumentEnv(orig_ctx.env)
			const config = initialiser(env, orig_ctx.request)
			const { ctx, tracker } = proxyExecutionContext(orig_ctx)
			const context = setConfig(config)

			try {
				const args: PageHandlerArgs = [ctx] as PageHandlerArgs
				return await api_context.with(context, executePageHandler, undefined, target, args)
			} catch (error) {
				throw error
			} finally {
				orig_ctx.waitUntil(exportSpans(tracker))
			}
		},
	}
	return wrap(pageFn, pagesHandler)
}
