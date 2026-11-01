/**
 * Formato bruto aceito no campo multipart `requestData` enviado pelo HTTP Body do DocuWare.
 * Suporta tanto a nomenclatura principal da especificação (`system_instruction`, `prompt`, `schema`)
 * quanto os aliases (`system_prompt`, `user_prompt`, `expected_fields`).
 */
export interface RawDocuWareRequestData {
  system_instruction?: string;
  system_prompt?: string;
  prompt?: string;
  user_prompt?: string;
  schema?: Record<string, unknown>;
  expected_fields?: string[];
}

/**
 * Instruções de extração normalizadas após o parsing de `requestData`.
 */
export interface NormalizedExtractionRequest {
  systemInstruction: string;
  userPrompt: string;
  schemaDefinition: Record<string, unknown> | null;
  mode: 'json_schema' | 'json_object';
}

/**
 * Métricas seguras de execução registradas nos logs (sem dados sensíveis do documento).
 */
export interface ExtractionMetrics {
  durationMs: number;
  fileSizeBytes: number;
  model: string;
  mode: 'json_schema' | 'json_object';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  attempts: number;
}

/**
 * Payload de erro padronizado para retorno ao DocuWare.
 */
export interface StandardErrorResponse {
  error: true;
  code:
    | 'UNAUTHORIZED'
    | 'INVALID_MULTIPART'
    | 'MISSING_FILE'
    | 'INVALID_PDF'
    | 'FILE_TOO_LARGE'
    | 'EXTRACTION_FAILED'
    | 'INTERNAL_ERROR';
  message: string;
}

