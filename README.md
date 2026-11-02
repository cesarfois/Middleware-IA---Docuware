# Universal Document AI Gateway (100% Orientado por Contrato JSON)

Middleware genérico em **Node.js (TypeScript + Fastify)** para o **DocuWare Cloud 7.14**, livre de prompts de negócio, schemas fixos ou templates documentais predefinidos no backend.

Toda a configuração funcional da extração — provedor, modelo, parâmetros de processamento, instruções, regras, campos de extração e estrutura de resposta — é definida exclusivamente e dinamicamente pelo JSON enviado no campo `requestData` pelo **DocuWare Workflow Designer**.

---

## 1. Endpoints em Produção (Contabo VPS)

| Tipo de Acesso | Endpoint de Extração (`POST`) | Healthcheck (`GET`) |
| :--- | :--- | :--- |
| **HTTPS Principal (`portal_nginx`)** | `https://wp.processcloud.app/ai-gateway/extract` | `https://wp.processcloud.app/ai-gateway/health` |
| **HTTP Domínio (`portal_nginx`)** | `http://wp.processcloud.app/ai-gateway/extract` | `http://wp.processcloud.app/ai-gateway/health` |
| **IP Direto (Porta `3014`)** | `http://13.140.173.35:3014/extract` | `http://13.140.173.35:3014/health` |

* **Cabeçalho de Autenticação:** `X-DocuWare-Token: <API_AUTH_TOKEN>` ou `Authorization: Bearer <API_AUTH_TOKEN>`
* **Formato de Entrada:** `multipart/form-data` contendo `file` (binário PDF) e `requestData` (JSON do contrato de extração).

---

## 2. Princípios Arquiteturais

1. **Zero Prompts de Negócio no Backend:** O middleware não possui conhecimento de tipos documentais específicos. Apenas uma diretiva técnica de protocolo (conformidade estrita com o JSON Schema) acompanha as instruções enviadas no `requestData`.
2. **Zero Schemas Fixos:** Nenhum nome de campo existe no código-fonte. O JSON Schema (`strict: true`, `additionalProperties: false`, `required` integral) é construído dinamicamente a partir de `extraction.fields`.
3. **Sem Fallback Silencioso:** Se `requestData` estiver ausente, vazio, em texto plano ou sem definição de instruções/campos, o middleware retorna erro explícito HTTP `422` com `code: "INVALID_CONFIGURATION"`.
4. **Validação e Filtragem Estrita de Saída:** A resposta JSON entregue ao DocuWare passa por `validateAndFilterResponse`, garantindo que contenha **exclusivamente** as propriedades solicitadas naquela requisição, sem adicionar nem renomear chaves.
5. **Múltiplos Provedores Protegidos no Servidor:** O contrato JSON pode selecionar o `provider` (`"openai"`, `"gemini"`, `"openai_compatible"`) e o `model`, enquanto as chaves de API e endpoints permanecem protegidos no `.env` do servidor.

---

## 3. Contrato JSON Padronizado (v2)

No editor **HTTP Body** da atividade **Web Service** do DocuWare Workflow Designer, envie a configuração seguindo o contrato canônico abaixo:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "processing": {
    "strategy": "native_pdf",
    "temperature": 0,
    "max_output_tokens": 2048,
    "timeout_ms": 45000
  },
  "instructions": {
    "system": "Papel ou contexto definido pelo próprio workflow.",
    "prompt": "Instrução principal do que deve ser analisado no documento PDF anexo.",
    "rules": [
      "Regra 1 definida pelo workflow",
      "Regra 2 definida pelo workflow"
    ]
  },
  "extraction": {
    "fields": {
      "Campo_Personalizado_1": {
        "type": "string",
        "description": "Descrição do campo 1",
        "format": "dd/MM/yyyy",
        "rule": "Regra específica deste campo"
      },
      "Campo_Personalizado_2": {
        "type": "string",
        "description": "Descrição do campo 2"
      }
    }
  },
  "response": {
    "strict": true,
    "null_handling": "empty_string"
  }
}
```

### Especificação das Seções do Contrato

| Bloco | Obrigatório | Descrição |
| :--- | :---: | :--- |
| `provider` | Opcional | Provedor habilitado no servidor: `"openai"` (padrão), `"gemini"` ou `"openai_compatible"`. |
| `model` | Opcional | Modelo do provedor (ex.: `"gpt-4o"`, `"gpt-4o-mini"`, `"gemini-2.5-flash"`). |
| `processing` | Opcional | Parâmetros técnicos de execução (`strategy`, `temperature`, `max_output_tokens`, `timeout_ms`). |
| `instructions` | **Sim** | Contém `prompt` (**obrigatório**), `system` (opcional) e `rules` (lista opcional de regras encaminhadas integralmente ao modelo). |
| `extraction` | **Sim** | Contém `fields` (**obrigatório**, com pelo menos 1 campo). Aceita objeto `{ "NomeCampo": { "type": "string", ... } }` ou lista `[{ "name": "NomeCampo", "type": "string", ... }]`. |
| `response` | Opcional | Define `strict` (`true`) e `null_handling` (`"empty_string"` padrão, `"type_default"` ou `"preserve_null"`). |

---

## 4. Adaptador Explícito de Compatibilidade Legada (v1)

Para preservar fluxos já configurados anteriormente sem misturar os formatos, o módulo [`adaptLegacyRequestData`](src/schema-builder.ts) converte explicitamente requisições que utilizem exclusivamente as três chaves do formato anterior (`system_instruction`, `prompt`, `schema`):

```json
{
  "system_instruction": "Contexto opcional definido pelo workflow",
  "prompt": "Instrução obrigatória definida pelo workflow",
  "schema": {
    "Campo_A": "Descrição do Campo A",
    "Campo_B": "Descrição do Campo B"
  }
}
```
> **Nota:** Não é permitido misturar chaves do contrato canônico (`instructions`, `extraction`, `provider`, `processing`, `response`) com chaves do formato legado (`system_instruction`, `prompt`, `schema`) na mesma requisição.

---

## 5. Teste de Aceitação Obrigatório (Mesmo PDF, 3 Contratos Distintos)

O script [`tests/curl-examples.sh`](tests/curl-examples.sh) executa o teste de aceitação enviando **o mesmo arquivo PDF três vezes** ao endpoint `https://wp.processcloud.app/ai-gateway/extract`:

### 1ª Execução: Solicitando somente `Cliente` e `Telefone`
```bash
curl -s -X POST "https://wp.processcloud.app/ai-gateway/extract" \
  -H "X-DocuWare-Token: docuware_token_2026" \
  -F "file=@./documento.pdf;type=application/pdf" \
  -F 'requestData={
    "provider": "openai",
    "model": "gpt-4o",
    "instructions": {
      "prompt": "Extraia apenas os dados solicitados nos campos abaixo."
    },
    "extraction": {
      "fields": {
        "Cliente": { "type": "string", "description": "Nome do cliente" },
        "Telefone": { "type": "string", "description": "Telefone de contato" }
      }
    }
  }'
```
**Resposta (exclusivamente os 2 campos solicitados):**
```json
{
  "Cliente": "...",
  "Telefone": "..."
}
```

### 2ª Execução (Mesmo PDF): Solicitando somente `N_Ticket`, `Tecnico` e `Numero_Serie`
```bash
curl -s -X POST "https://wp.processcloud.app/ai-gateway/extract" \
  -H "X-DocuWare-Token: docuware_token_2026" \
  -F "file=@./documento.pdf;type=application/pdf" \
  -F 'requestData={
    "provider": "openai",
    "model": "gpt-4o",
    "instructions": {
      "prompt": "Extraia apenas os identificadores solicitados nos campos abaixo."
    },
    "extraction": {
      "fields": {
        "N_Ticket": { "type": "string", "description": "Número do ticket" },
        "Tecnico": { "type": "string", "description": "Nome do técnico" },
        "Numero_Serie": { "type": "string", "description": "Número de série" }
      }
    }
  }'
```
**Resposta (exclusivamente os 3 campos solicitados):**
```json
{
  "N_Ticket": "...",
  "Tecnico": "...",
  "Numero_Serie": "..."
}
```

### 3ª Execução (Mesmo PDF): Solicitando somente `Campo_A`, `Campo_B` e `Campo_C`
```bash
curl -s -X POST "https://wp.processcloud.app/ai-gateway/extract" \
  -H "X-DocuWare-Token: docuware_token_2026" \
  -F "file=@./documento.pdf;type=application/pdf" \
  -F 'requestData={
    "provider": "openai",
    "model": "gpt-4o",
    "instructions": {
      "prompt": "Extraia os valores solicitados nas propriedades personalizadas abaixo."
    },
    "extraction": {
      "fields": {
        "Campo_A": { "type": "string", "description": "Primeira informação solicitada" },
        "Campo_B": { "type": "string", "description": "Segunda informação solicitada" },
        "Campo_C": { "type": "string", "description": "Terceira informação solicitada" }
      }
    }
  }'
```
**Resposta (exclusivamente os 3 campos solicitados):**
```json
{
  "Campo_A": "...",
  "Campo_B": "...",
  "Campo_C": "..."
}
```

---

## 6. Estrutura do Repositório e CI/CD

```text
.
├── .github/workflows/
│   └── deploy.yml             # Pipeline CI/CD GitHub Actions (deploy automático via SSH na Contabo)
├── scripts/
│   └── configure-nginx.sh     # Script idempotente que configura /ai-gateway/ no portal_nginx
├── src/
│   ├── server.ts              # Inicialização Fastify, limites multipart e handler global
│   ├── config.ts              # Credenciais e configurações protegidas por variáveis de ambiente (.env)
│   ├── types.ts               # Contrato Canônico v2, Adaptador Legado v1 e tipos de validação
│   ├── auth.ts                # Autenticação time-safe (X-DocuWare-Token ou Authorization: Bearer)
│   ├── schema-builder.ts      # Validador de contrato, gerador dinâmico de JSON Schema e filtro estrito de saída
│   ├── openai-service.ts      # Dispatcher multi-provider (OpenAI / Gemini / Compatible) com retry exponencial
│   ├── routes/
│   │   ├── extract.ts         # Endpoints POST (/ai-gateway/extract, /extract, /api/extract, /)
│   │   └── health.ts          # Endpoints GET (/ai-gateway/health, /health)
│   └── tests/
│       └── gateway.test.ts    # Suíte de testes unitários e teste de aceitação das 3 execuções
├── tests/
│   └── curl-examples.sh       # Script executável com o Teste de Aceitação Obrigatório (3 execuções no mesmo PDF)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── tsconfig.json
```
