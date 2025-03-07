import { context as api_context, trace, SpanOptions, SpanKind, Exception, SpanStatusCode } from '@opentelemetry/api'
import { SemanticAttributes } from '@opentelemetry/semantic-conventions'
import { passthroughGet, unwrap, wrap, isProxyable } from '../wrap.js'
// import { getParentContextFromHeaders, gatherRequestAttributes, gatherResponseAttributes } from './fetch.js'
import { instrumentEnv } from './env.js'
import { Initialiser, setConfig } from '../config.js'
// import { exportSpans, proxyExecutionContext } from './common.js'
import { exportSpans } from './common.js'
import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers'

/**
 * Instruments a class that extends WorkerEntrypoint, tracing all method calls
 * made via RPC.
 */
export function instrumentRpcClass<T extends new (...args: any[]) => WorkerEntrypoint>(
	rpcClass: T,
	initialiser: Initialiser,
): T {
	const classHandler: ProxyHandler<T> = {
		construct(target, args) {
			// Create the original instance
			const instance = new target(...args)

			// Create a proxy for the instance
			return instrumentRpcInstance(instance, initialiser)
		},
	}

	return wrap(rpcClass, classHandler)
}

/**
 * Instruments an instance of a WorkerEntrypoint class, wrapping its methods
 * to trace RPC calls.
 */
function instrumentRpcInstance(instance: InstanceType<typeof WorkerEntrypoint>, initialiser: Initialiser) {
	const instanceHandler: ProxyHandler<typeof instance> = {
		get(target, prop, receiver) {
			// Get the original property or method
			const value = Reflect.get(target, prop, receiver)

			// Special handling for constructor properties
			if (prop === 'constructor') {
				return value
			}

			// Only instrument methods
			if (
				typeof value === 'function' &&
				prop !== 'fetch' && // fetch is already handled by the fetch instrumentation
				prop !== Symbol.dispose &&
				prop !== Symbol.asyncDispose
			) {
				// Create a wrapped method that traces execution
				return instrumentRpcMethod(value, String(prop), initialiser, target)
			}

			return value
		},
	}

	return wrap(instance, instanceHandler)
}

/**
 * Instruments an individual method on a WorkerEntrypoint instance.
 */
function instrumentRpcMethod(method: Function, methodName: string, initialiser: Initialiser, instance: any) {
	const methodHandler: ProxyHandler<Function> = {
		apply: async function (target, thisArg, args) {
			// Extract environment from the instance if available
			const env = instance && instance.env ? instrumentEnv(instance.env as Record<string, unknown>) : {}

			// Create config and context for this trace
			const config = initialiser(env as Record<string, unknown>, {
				method: methodName,
				args: args,
			})
			const context = setConfig(config)

			// Execute the method with tracing
			try {
				return await api_context.with(context, executeRpcMethod, undefined, target, thisArg, args, methodName)
			} catch (error) {
				throw error
			} finally {
				await exportSpans()
			}
		},
	}

	return wrap(method, methodHandler)
}

/**
 * Executes an RPC method with tracing.
 */
async function executeRpcMethod(method: Function, thisArg: any, args: any[], methodName: string): Promise<any> {
	const tracer = trace.getTracer('rpc')

	// Create span attributes
	const attributes = {
		[SemanticAttributes.RPC_SYSTEM]: 'cloudflare_workers',
		[SemanticAttributes.RPC_SERVICE]: thisArg.constructor.name,
		[SemanticAttributes.RPC_METHOD]: methodName,
		'rpc.arguments_count': args.length,
	}

	// Create a span for this RPC call
	const options: SpanOptions = {
		attributes,
		kind: SpanKind.SERVER,
	}

	// Start the span and execute the method
	return tracer.startActiveSpan(`RPC ${methodName}`, options, async (span) => {
		try {
			// Execute the original method
			const result = await Reflect.apply(method, unwrap(thisArg), args)

			// Add result information to the span
			span.setAttribute('rpc.success', true)
			span.setAttribute('rpc.has_result', result !== undefined && result !== null)

			// Complete the span
			span.end()
			return result
		} catch (error) {
			// Record errors
			span.recordException(error as Exception)
			span.setAttribute('rpc.success', false)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			throw error
		}
	})
}

/**
 * Instruments a class that extends RpcTarget for cross-service tracing
 */
export function instrumentRpcTargetClass<T extends new (...args: any[]) => RpcTarget>(
	targetClass: T,
	initialiser: Initialiser,
): T {
	const classHandler: ProxyHandler<T> = {
		construct(target, args) {
			const instance = new target(...args)
			return instrumentRpcTargetInstance(instance, initialiser)
		},
	}

	return wrap(targetClass, classHandler)
}

/**
 * Instruments an instance of an RpcTarget class
 */
function instrumentRpcTargetInstance(instance: InstanceType<typeof RpcTarget>, initialiser: Initialiser) {
	const instanceHandler: ProxyHandler<typeof instance> = {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver)

			// Skip special properties and non-functions
			if (
				prop === 'constructor' ||
				prop === Symbol.dispose ||
				prop === Symbol.asyncDispose ||
				typeof value !== 'function'
			) {
				return value
			}

			// Wrap the method with tracing
			return instrumentRpcTargetMethod(value, String(prop), initialiser, target)
		},
	}

	return wrap(instance, instanceHandler)
}

/**
 * Instruments an individual method on an RpcTarget instance
 */
function instrumentRpcTargetMethod(method: Function, methodName: string, initialiser: Initialiser, instance: any) {
	const methodHandler: ProxyHandler<Function> = {
		apply: async function (target, thisArg, args) {
			// For RpcTarget we might not have direct access to env
			// So we'll create a minimal config
			const env = {}
			const config = initialiser(env as Record<string, unknown>, {
				method: methodName,
				args: args,
			})
			const context = setConfig(config)

			try {
				return await api_context.with(context, executeRpcTargetMethod, undefined, target, thisArg, args, methodName)
			} catch (error) {
				throw error
			}
		},
	}

	return wrap(method, methodHandler)
}

/**
 * Executes an RpcTarget method with tracing
 */
async function executeRpcTargetMethod(method: Function, thisArg: any, args: any[], methodName: string): Promise<any> {
	const tracer = trace.getTracer('rpc-target')

	const attributes = {
		'rpc.target.class': thisArg.constructor.name,
		'rpc.target.method': methodName,
		'rpc.target.arguments_count': args.length,
	}

	const options: SpanOptions = {
		attributes,
		kind: SpanKind.INTERNAL,
	}

	return tracer.startActiveSpan(`RpcTarget ${methodName}`, options, async (span) => {
		try {
			const result = await Reflect.apply(method, unwrap(thisArg), args)
			span.setAttribute('rpc.target.success', true)
			span.end()
			return result
		} catch (error) {
			span.recordException(error as Exception)
			span.setAttribute('rpc.target.success', false)
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.end()
			throw error
		}
	})
}

/**
 * Detect and instrument RPC service bindings
 */
export function instrumentRpcBinding(service: any, bindingName: string): any {
	// Check if this is a RPC stub
	if (!isRpcStub(service)) {
		return service
	}

	const bindingHandler: ProxyHandler<typeof service> = {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && prop !== 'fetch' && prop !== 'then') {
				// This is likely an RPC method call
				const method = Reflect.get(target, prop, receiver)

				if (typeof method === 'function') {
					return instrumentRpcBindingMethod(method, bindingName, String(prop))
				}
			}

			return passthroughGet(target, prop, receiver)
		},
	}

	return wrap(service, bindingHandler)
}

/**
 * Instruments a method call on an RPC binding
 */
function instrumentRpcBindingMethod(method: Function, bindingName: string, methodName: string) {
	const methodHandler: ProxyHandler<Function> = {
		apply: async function (target, thisArg, args) {
			const tracer = trace.getTracer('rpc-client')

			const attributes = {
				'rpc.client.binding': bindingName,
				'rpc.client.method': methodName,
				'rpc.client.arguments_count': args.length,
			}

			const options: SpanOptions = {
				attributes,
				kind: SpanKind.CLIENT,
			}

			return tracer.startActiveSpan(`RPC ${bindingName}.${methodName}`, options, async (span) => {
				try {
					// Call the original method
					const result = await Reflect.apply(target, unwrap(thisArg), args)

					// Add result info to span
					span.setAttribute('rpc.client.success', true)
					span.end()

					return result
				} catch (error) {
					span.recordException(error as Exception)
					span.setAttribute('rpc.client.success', false)
					span.setStatus({ code: SpanStatusCode.ERROR })
					span.end()
					throw error
				}
			})
		},
	}

	return wrap(method, methodHandler)
}

/**
 * Determines if an object is an RPC stub
 */
function isRpcStub(obj: any): boolean {
	if (!isProxyable(obj)) {
		return false
	}

	// This is a heuristic check - RPC stubs have a handler proxy
	// that responds to property access with functions
	// Let's check for a few common RPC patterns
	try {
		const props = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {})

		// If it only has the common JavaScript object methods, it's likely an RPC stub
		const commonMethods = ['constructor', 'then', 'toString', 'valueOf']
		if (props.length <= commonMethods.length && props.every((p) => commonMethods.includes(p))) {
			return true
		}

		// Another approach is to check if accessing a non-existent property
		// returns a function (typical of RPC stubs)
		const testProp = `__test_rpc_${Math.random()}`
		const testMethod = obj[testProp]
		return typeof testMethod === 'function'
	} catch (e) {
		// If we can't determine, be conservative
		return false
	}
}
