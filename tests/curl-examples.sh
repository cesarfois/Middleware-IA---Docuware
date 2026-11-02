#!/usr/bin/env bash
# ============================================================================
# TESTE DE ACEITAÇÃO OBRIGATÓRIO - UNIVERSAL DOCUMENT AI GATEWAY
# Envia o MESMO PDF 3 vezes ao mesmo endpoint solicitando conjuntos distintos
# de propriedades via JSON (requestData).
# ============================================================================

set -e

GATEWAY_URL="${GATEWAY_URL:-https://wp.processcloud.app/ai-gateway/extract}"
HEALTH_URL="${HEALTH_URL:-https://wp.processcloud.app/ai-gateway/health}"
API_TOKEN="${API_AUTH_TOKEN:-docuware_token_2026}"
SAMPLE_PDF="${SAMPLE_PDF:-/tmp/acceptance_sample.pdf}"

# Gera um PDF único de teste caso não exista no caminho indicado
if [ ! -f "$SAMPLE_PDF" ]; then
  printf "%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 175>>stream\nBT /F1 11 Tf 40 700 Td (DOCUMENTO DE TESTE - Cliente: RCS Vision Lda | Telefone: +351 210 999 888 | Ticket: 45901 | Tecnico: Joao Silva | Serie: SN-998877 | Codigo A: Alfa | Codigo B: Beta | Codigo C: Gama) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000204 00000 n \n0000000430 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n497\n%%%%EOF" > "$SAMPLE_PDF"
fi

echo "=== 0. Verificando Healthcheck ($HEALTH_URL) ==="
curl -s "$HEALTH_URL"
echo -e "\n"

echo "=== 1ª Execução (Mesmo PDF): Solicitando EXCLUSIVAMENTE Cliente e Telefone ==="
curl -s -X POST "$GATEWAY_URL" \
  -H "X-DocuWare-Token: $API_TOKEN" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  -F 'requestData={
    "provider": "openai",
    "model": "gpt-4o",
    "processing": { "strategy": "native_pdf", "temperature": 0 },
    "instructions": {
      "prompt": "Extraia apenas os dados solicitados nos campos abaixo a partir do documento PDF."
    },
    "extraction": {
      "fields": {
        "Cliente": { "type": "string", "description": "Nome do cliente" },
        "Telefone": { "type": "string", "description": "Número de telefone" }
      }
    },
    "response": { "strict": true, "null_handling": "empty_string" }
  }'
echo -e "\n"

echo "=== 2ª Execução (Mesmo PDF): Solicitando EXCLUSIVAMENTE N_Ticket, Tecnico e Numero_Serie ==="
curl -s -X POST "$GATEWAY_URL" \
  -H "X-DocuWare-Token: $API_TOKEN" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  -F 'requestData={
    "provider": "openai",
    "model": "gpt-4o",
    "processing": { "strategy": "native_pdf", "temperature": 0 },
    "instructions": {
      "prompt": "Extraia apenas os identificadores técnicos solicitados nos campos abaixo."
    },
    "extraction": {
      "fields": {
        "N_Ticket": { "type": "string", "description": "Número do ticket" },
        "Tecnico": { "type": "string", "description": "Nome do técnico" },
        "Numero_Serie": { "type": "string", "description": "Número de série" }
      }
    },
    "response": { "strict": true, "null_handling": "empty_string" }
  }'
echo -e "\n"

echo "=== 3ª Execução (Mesmo PDF): Solicitando EXCLUSIVAMENTE Campo_A, Campo_B e Campo_C ==="
curl -s -X POST "$GATEWAY_URL" \
  -H "X-DocuWare-Token: $API_TOKEN" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  -F 'requestData={
    "provider": "openai",
    "model": "gpt-4o",
    "processing": { "strategy": "native_pdf", "temperature": 0 },
    "instructions": {
      "prompt": "Mapeie os três códigos presentes no documento para as propriedades personalizadas solicitadas."
    },
    "extraction": {
      "fields": {
        "Campo_A": { "type": "string", "description": "Valor do Código A" },
        "Campo_B": { "type": "string", "description": "Valor do Código B" },
        "Campo_C": { "type": "string", "description": "Valor do Código C" }
      }
    },
    "response": { "strict": true, "null_handling": "empty_string" }
  }'
echo -e "\n"
