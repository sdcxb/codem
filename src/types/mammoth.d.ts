declare module 'mammoth/mammoth.browser.js' {
  export interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
}
