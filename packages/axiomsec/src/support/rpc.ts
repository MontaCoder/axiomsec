type Definition = {
  [method: string]: (input: any) => any
}

const READY = JSON.stringify({ type: "rpc.ready" })
const PING = JSON.stringify({ type: "rpc.ping" })

export function listen(rpc: Definition) {
  onmessage = (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.ping") {
      postMessage(READY)
      return
    }
    if (parsed.type !== "rpc.request") return
    void Promise.resolve()
      .then(() => rpc[parsed.method](parsed.input))
      .then(
        (result) => postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id })),
        (error) =>
          postMessage(
            JSON.stringify({
              type: "rpc.error",
              error: error instanceof Error ? error.message : String(error),
              id: parsed.id,
            }),
          ),
      )
  }
  postMessage(READY)
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  const queue: string[] = []
  let id = 0
  let ready = false
  let ping: ReturnType<typeof setInterval> | undefined

  const send = (data: string) => {
    if (ready) target.postMessage(data)
    else queue.push(data)
  }

  const handshake = () => {
    if (ready) return
    target.postMessage(PING)
  }

  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.ready") {
      if (ready) return
      ready = true
      if (ping) clearInterval(ping)
      ping = undefined
      for (const message of queue.splice(0)) target.postMessage(message)
      return
    }
    if (parsed.type === "rpc.result") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        resolve.resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.error") {
      const reject = pending.get(parsed.id)
      if (reject) {
        reject.reject(new Error(parsed.error))
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }

  handshake()
  ping = setInterval(handshake, 50)
  ping.unref?.()

  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        send(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}
