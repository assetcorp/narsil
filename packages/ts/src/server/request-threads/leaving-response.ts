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
  ) {}

  get isFinished(): boolean {
    return this.finished
  }

  whenFinished(callback: () => void): void {
    if (this.finished) callback()
    else this.onFinish = callback
  }

  refuse(status: number, envelope: ErrorEnvelope): void {
    if (this.finished) return
    if (this.headStarted) {
      this.close()
      return
    }
    refuseAndClose(this.res, status, envelope)
    this.headStarted = true
    this.finish()
  }

  cork(callback: () => void): ResponseSink {
    this.res.cork(callback)
    return this
  }

  writeStatus(status: string): ResponseSink {
    this.res.writeStatus(status)
    this.startHead()
    return this
  }

  writeHeader(key: string, value: string): ResponseSink {
    this.startHead()
    this.res.writeHeader(key, value)
    return this
  }

  end(body?: string | Uint8Array, closeConnection?: boolean): ResponseSink {
    this.startHead()
    this.res.end(body, closeConnection === true || this.closesConnection)
    this.finish()
    return this
  }

  write(chunk: Uint8Array): boolean {
    this.startHead()
    return this.res.write(chunk)
  }

  pause(): void {
    this.res.pause()
  }

  resume(): void {
    this.res.resume()
  }

  close(): ResponseSink {
    this.res.close()
    this.finish()
    return this
  }

  endWithoutBody(): ResponseSink {
    this.startHead()
    this.res.endWithoutBody()
    this.finish()
    return this
  }

  tryEnd(body: Uint8Array, totalSize: number): [boolean, boolean] {
    this.startHead()
    const result = this.res.tryEnd(body, totalSize)
    if (result[1]) this.finish()
    return result
  }

  getWriteOffset(): number {
    return this.res.getWriteOffset()
  }

  onWritable(handler: (offset: number) => boolean): ResponseSink {
    this.res.onWritable(handler)
    return this
  }

  onAborted(handler: () => void): ResponseSink {
    this.res.onAborted(handler)
    return this
  }

  onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): ResponseSink {
    this.res.onData(handler)
    return this
  }

  getRemoteAddressAsText(): ArrayBuffer {
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
