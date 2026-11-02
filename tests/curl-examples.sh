#!/usr/bin/env bash
# ============================================================================
# TESTES DE ACEITAÇÃO E EXEMPLOS CURL - UNIVERSAL DOCUMENT AI GATEWAY
# 1. Endpoint /ai-gateway/extract (3 execuções dinâmicas sobre o mesmo PDF)
# 2. Endpoint /ai-gateway/textshot (Recuperação de Textshot via DocuWare Platform API)
# ============================================================================

set -e

GATEWAY_URL="${GATEWAY_URL:-https://wp.processcloud.app/ai-gateway/extract}"
TEXTSHOT_URL="${TEXTSHOT_URL:-https://wp.processcloud.app/ai-gateway/textshot}"
TRAIN_URL="${TRAIN_URL:-https://wp.processcloud.app/ai-gateway/train}"
TRAIN_STATUS_URL="${TRAIN_STATUS_URL:-https://wp.processcloud.app/ai-gateway/train/status}"
CLASSIFY_URL="${CLASSIFY_URL:-https://wp.processcloud.app/ai-gateway/classify}"
HEALTH_URL="${HEALTH_URL:-https://wp.processcloud.app/ai-gateway/health}"
API_TOKEN="${API_AUTH_TOKEN:-docuware_token_2026}"
SAMPLE_PDF="${SAMPLE_PDF:-/tmp/acceptance_sample.pdf}"

if [ ! -f "$SAMPLE_PDF" ]; then
  printf "%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 175>>stream\nBT /F1 11 Tf 40 700 Td (DOCUMENTO DE TESTE - Cliente: RCS Vision Lda | Telefone: +351 210 999 888 | Ticket: 45901 | Tecnico: Joao Silva | Serie: SN-998877 | Codigo A: Alfa | Codigo B: Beta | Codigo C: Gama) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000204 00000 n \n0000000430 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n497\n%%%%EOF" > "$SAMPLE_PDF"
fi

echo "=== 0. Verificando Healthcheck ($HEALTH_URL) ==="
curl -s "$HEALTH_URL"
echo -e "\n"

echo "=== 1ª Execução (/extract): Solicitando EXCLUSIVAMENTE Cliente e Telefone ==="
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

echo "=== 2ª Execução (/extract): Solicitando EXCLUSIVAMENTE N_Ticket, Tecnico e Numero_Serie ==="
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

echo "=== 3ª Execução (/extract): Solicitando EXCLUSIVAMENTE Campo_A, Campo_B e Campo_C ==="
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

echo "=== 4ª Execução (/textshot): Recuperando Textshot nativo da DocuWare Platform API ==="
if [ -n "${DOCUWARE_CABINET_ID:-}" ] && [ -n "${DOCUWARE_DOCUMENT_ID:-}" ]; then
  curl -s -X POST "$TEXTSHOT_URL" \
    -H "X-DocuWare-Token: $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"fileCabinetId\": \"${DOCUWARE_CABINET_ID}\",
      \"documentId\": ${DOCUWARE_DOCUMENT_ID},
      \"options\": {
        \"includePages\": true,
        \"includeCoordinates\": false,
        \"normalize\": true,
        \"output\": \"text\",
        \"maxCharacters\": 2000
      }
    }"
  echo -e "\n"

  echo "=== 5ª Execução (/train): Submetendo documento para aprendizagem supervisionada local ==="
  TRAIN_RES=$(curl -s -X POST "$TRAIN_URL" \
    -H "X-DocuWare-Token: $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"fileCabinetId\": \"${DOCUWARE_CABINET_ID}\",
      \"documentId\": ${DOCUWARE_DOCUMENT_ID},
      \"documentType\": \"${DOCUWARE_DOCUMENT_TYPE:-Ficha de Intervenção}\"
    }")
  echo "$TRAIN_RES"
  echo -e "\n"

  echo "=== 6ª Execução (/train/status): Consultando estado do trabalho de aprendizagem ==="
  curl -s "${TRAIN_STATUS_URL}?trainingId=trn-000001" \
    -H "X-DocuWare-Token: $API_TOKEN"
  echo -e "\n"

  echo "=== 7ª Execução (/classify): Classificando documento com o modelo local ==="
  curl -s -X POST "$CLASSIFY_URL" \
    -H "X-DocuWare-Token: $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"fileCabinetId\": \"${DOCUWARE_CABINET_ID}\",
      \"documentId\": ${DOCUWARE_DOCUMENT_ID}
    }"
  echo -e "\n"
else
  echo "Para testar /textshot, /train e /classify com um documento real, defina DOCUWARE_CABINET_ID e DOCUWARE_DOCUMENT_ID."
fi
