import { encodeJson } from '../../json-encoding'
import { type ResponseSink, statusLine } from '../response'
import type { ErrorEnvelope } from '../types'

export function refuseAndClose(res: ResponseSink, status: number, envelope: ErrorEnvelope): void {
  const payload = encodeJson(envelope)
  res.cork(() => {
    res
      .writeStatus(statusLine(status))
      .writeHeader('Content-Type', 'application/json')
      .writeHeader('Connection', 'close')
      .end(payload, true)
  })
}

export class LeavingResponse implements ResponseSink {
  private headStarted = false
  private closesConnection = false
  private finished = false
  private onFinish: (() => void) | null = null

  constructor(
    private readonly res: ResponseSink,
    private readonly leaving: () => boolean,
    private readonly canRespond: () => boolean = () => true,
  ) {}

  get isFinished(): boolean {
    return this.finished
  }

  whenFinished(callback: () => void): void {
    if (this.finished) callback()
    else this.onFinish = callback
  }

  refuse(status: number, envelope: ErrorEnvelope): void {
    if (this.finished || !this.canRespond()) return
    if (this.headStarted) {
      this.close()
      return
    }
    refuseAndClose(this.res, status, envelope)
    this.headStarted = true
    this.finish()
  }

  cork(callback: () => void): ResponseSink {
    if (!this.canRespond()) return this
    this.res.cork(callback)
    return this
  }

  writeStatus(status: string): ResponseSink {
    if (!this.canRespond()) return this
    this.res.writeStatus(status)
    this.startHead()
    return this
  }

  writeHeader(key: string, value: string): ResponseSink {
    if (!this.canRespond()) return this
    this.startHead()
    this.res.writeHeader(key, value)
    return this
  }

  end(body?: string | Uint8Array, closeConnection?: boolean): ResponseSink {
    if (!this.canRespond()) return this
    this.startHead()
    this.res.end(body, closeConnection === true || this.closesConnection)
    this.finish()
    return this
  }

  write(chunk: Uint8Array): boolean {
    if (!this.canRespond()) return false
    this.startHead()
    return this.res.write(chunk)
  }

  pause(): void {
    if (!this.canRespond()) return
    this.res.pause()
  }

  resume(): void {
    if (!this.canRespond()) return
    this.res.resume()
  }

  close(): ResponseSink {
    if (!this.canRespond()) return this
    this.res.close()
    this.finish()
    return this
  }

  endWithoutBody(): ResponseSink {
    if (!this.canRespond()) return this
    this.startHead()
    this.res.endWithoutBody()
    this.finish()
    return this
  }

  tryEnd(body: Uint8Array, totalSize: number): [boolean, boolean] {
    if (!this.canRespond()) return [false, false]
    this.startHead()
    const result = this.res.tryEnd(body, totalSize)
    if (result[1]) this.finish()
    return result
  }

  getWriteOffset(): number {
    if (!this.canRespond()) return 0
    return this.res.getWriteOffset()
  }

  onWritable(handler: (offset: number) => boolean): ResponseSink {
    if (!this.canRespond()) return this
    this.res.onWritable(offset => (this.canRespond() ? handler(offset) : true))
    return this
  }

  onAborted(handler: () => void): ResponseSink {
    if (!this.canRespond()) {
      handler()
      return this
    }
    this.res.onAborted(handler)
    return this
  }

  onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): ResponseSink {
    if (!this.canRespond()) return this
    this.res.onData((chunk, isLast) => {
      if (this.canRespond()) handler(chunk, isLast)
    })
    return this
  }

  getRemoteAddressAsText(): ArrayBuffer {
    if (!this.canRespond()) return new ArrayBuffer(0)
    return this.res.getRemoteAddressAsText()
  }

  private startHead(): void {
    if (this.headStarted) return
    this.headStarted = true
    if (!this.leaving()) return
    this.closesConnection = true
    this.res.writeHeader('Connection', 'close')
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    const callback = this.onFinish
    this.onFinish = null
    callback?.()
  }
}
