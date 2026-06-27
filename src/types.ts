export interface CliEvent {
  type: string;
  method: string;
  params: Record<string, unknown>;
}
