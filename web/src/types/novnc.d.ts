declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string | WebSocket)
    scaleViewport: boolean
    resizeSession: boolean
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(): void
    clipboardPasteFrom(text: string): void
  }
}
