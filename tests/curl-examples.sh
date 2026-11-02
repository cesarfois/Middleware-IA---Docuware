#!/usr/bin/env bash
# ============================================================================
# EXEMPLOS DE TESTE COM CURL - GATEWAY UNIVERSAL DOCUWARE <-> OPENAI GPT-4o
# ============================================================================

GATEWAY_URL="${GATEWAY_URL:-http://wp.processcloud.app/ai-gateway/extract}"
HEALTH_URL="${HEALTH_URL:-http://wp.processcloud.app/ai-gateway/health}"
API_TOKEN="${API_AUTH_TOKEN:-docuware_token_2026}"
SAMPLE_PDF="${SAMPLE_PDF:-./sample.pdf}"

echo "=== 0. Verificando Healthcheck ==="
curl -s "$HEALTH_URL" | jq .

echo -e "\n=== Cenário A: Contrato (Partes, Vigência, Valor e Foro) ==="
curl -s -X POST "$GATEWAY_URL" \
  -H "X-DocuWare-Token: $API_TOKEN" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um auditor jurídico especialista em análise de contratos corporativos.",
    "prompt": "Identifique as partes contratantes, a data de início de vigência, o valor total acordado e o foro.",
    "schema": {
      "Contratante": "Razão social da parte contratante",
      "Contratada": "Razão social da prestadora",
      "Vigencia_Inicio": "Data no formato dd/MM/yyyy",
      "Valor_Total": "Valor numérico ou formatado",
      "Foro": "Cidade/Comarca do foro contratual"
    }
  }' | jq .

echo -e "\n=== Cenário B: Fatura / Nota Fiscal (Número, Data, Total e Itens) ==="
curl -s -X POST "$GATEWAY_URL" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um analista fiscal especialista em faturas e notas fiscais.",
    "prompt": "Extraia número da fatura, data de emissão, fornecedor, valor total e os itens da nota.",
    "schema": {
      "Numero_Fatura": "Número da fatura ou NF",
      "Data_Emissao": "Data no formato dd/MM/yyyy",
      "Fornecedor": "Razão social do emissor",
      "Valor_Total": "Valor total da fatura",
      "Itens": [
        {
          "Descricao": "Descrição do produto ou serviço",
          "Quantidade": "Quantidade",
          "Valor_Total_Item": "Subtotal do item"
        }
      ]
    }
  }' | jq .

echo -e "\n=== Cenário C: Ficha de Intervenção ou Formulário Manuscrito ==="
curl -s -X POST "$GATEWAY_URL" \
  -H "X-DocuWare-Token: $API_TOKEN" \
  -F "file=@${SAMPLE_PDF};type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um especialista em OCR de formulários de campo e caligrafia manuscrita.",
    "prompt": "Extraia os campos impressos e manuscritos desta ficha técnica de intervenção.",
    "schema": {
      "Numero_Ficha": "Número identificador da ficha",
      "Data_Atendimento": "Data no formato dd/MM/yyyy",
      "Cliente": "Nome do cliente",
      "Tecnico": "Nome do técnico responsável",
      "Descricao_Manuscrita": "Transcrição completa do texto manuscrito pelo técnico",
      "Assinado": "SIM ou NAO"
    }
  }' | jq .

