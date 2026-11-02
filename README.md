# Gateway Universal de Inteligência Documental (DocuWare Cloud 7.14 ↔ OpenAI GPT-4o)

Microserviço containerizado em **Node.js (TypeScript + Fastify)** projetado para operar como **Gateway Universal de Extração Documental** para o **DocuWare Cloud 7.14**.

Com esta arquitetura orientada a metadados, você mantém **um único serviço na VPS** e define dinamicamente o que extrair e quais campos JSON retornar diretamente no editor **HTTP Body** de cada atividade de Workflow no DocuWare.

---

## 1. Endpoints em Produção (Contabo VPS)

| Tipo de Acesso | Endpoint de Extração (`POST`) | Healthcheck (`GET`) |
| :--- | :--- | :--- |
| **HTTPS Principal (`portal_nginx`)** | `https://wp.processcloud.app/ai-gateway/extract` | `https://wp.processcloud.app/ai-gateway/health` |
| **HTTP Domínio (`portal_nginx`)** | `http://wp.processcloud.app/ai-gateway/extract` | `http://wp.processcloud.app/ai-gateway/health` |
| **IP Direto (Porta `3014`)** | `http://13.140.173.35:3014/extract` | `http://13.140.173.35:3014/health` |

* **Diretório na VPS:** `/app/middleware-ia-docuware`
* **Container Docker:** `docuware-ai-gateway` (porta `3014`)
* **Cabeçalho de Autenticação:** `X-DocuWare-Token: <API_AUTH_TOKEN>` ou `Authorization: Bearer <API_AUTH_TOKEN>`

---

## 2. Arquitetura e Mecânica do Multipart no DocuWare 7.14

```text
[DocuWare Cloud 7.14 - Workflow Designer]
  │
  ├─► [x] Anexar documento: PDF enviado no campo binário 'file'
  └─► HTTP Body: JSON enviado automaticamente no campo 'requestData'
         {
           "system_instruction": "Você é um auditor de contratos...",
           "prompt": "Extraia partes contratantes, vigência, valor e foro.",
           "schema": {
             "Contratante": "Razão social da contratante",
             "Contratada": "Razão social da contratada",
             "Vigencia_Inicio": "Data no formato dd/MM/yyyy",
             "Valor_Total": "Valor numérico",
             "Foro": "Cidade/Comarca"
           }
         }
       │
       ▼
[Gateway Universal na VPS (wp.processcloud.app/ai-gateway/extract)]
       │
       ├─► 1. Valida Token (X-DocuWare-Token / Authorization Bearer)
       ├─► 2. Lê o PDF em memória (sem gravar nada em disco) e valida assinatura %PDF-
       ├─► 3. Interpreta o requestData e monta o JSON Schema dinâmico (strict: true)
       ├─► 4. Executa OpenAI GPT-4o (com retry automático e backoff exponencial)
       │
       ▼
[Retorno HTTP 200 OK - JSON Plano]
  {
    "Contratante": "Alfa Indústria Ltda",
    "Contratada": "Beta Tecnologia S.A.",
    "Vigencia_Inicio": "02/11/2026",
    "Valor_Total": "15000.00",
    "Foro": "Lisboa"
  }
```

---

## 3. Como Configurar no DocuWare Cloud 7.14

### Passo 1: Cadastrar o Serviço Web (1 única vez)
Em **DocuWare Configurações (Configurations)** ➔ **Web Services**:
1. Crie um novo serviço **REST**:
   * **Nome:** `Gateway Universal IA`
   * **URL Raiz:** `https://wp.processcloud.app/ai-gateway`
2. Em **Cabeçalhos Padrão (Default Headers)**, adicione:
   * **Nome:** `X-DocuWare-Token`
   * **Valor:** `docuware_token_2026` *(valor definido em `API_AUTH_TOKEN` no `.env` da VPS)*

---

### Passo 2: Configurar a Atividade no Workflow Designer
Em qualquer fluxo do **DocuWare Workflow Designer**, adicione uma atividade **Web Service**:

1. **Aba Pedido (Request):**
   * **Serviço Web:** `Gateway Universal IA`
   * **Método HTTP:** `POST`
   * **Rota / Caminho:** `/extract`
   * **Anexo:** Marque **[x] Anexar documento** (*Attach document*)
   * **HTTP Body:** Cole o JSON com o `prompt` e o `schema` desejado para aquele fluxo (veja exemplos na Seção 4).
2. **Aba Resposta (Response):**
   * Clique em **Enviar Pedido de Teste (Send Test Request)** anexando um PDF de exemplo.
   * Mapeie os campos retornados (`$.Campo_1`, `$.Campo_2`, etc.) diretamente para os campos de índice do armário ou variáveis globais do Workflow.

---

## 4. Templates Prontos para o "HTTP Body" do DocuWare

Basta copiar e colar no campo **HTTP Body** da atividade do DocuWare Workflow Designer:

### A) Contratos
```json
{
  "system_instruction": "Você é um auditor jurídico especialista em análise de contratos corporativos.",
  "prompt": "Identifique as partes contratantes, NIF/CNPJ, data de início de vigência, valor total acordado e o foro.",
  "schema": {
    "Contratante": "Razão social da parte contratante",
    "Documento_Contratante": "NIF ou CNPJ da contratante",
    "Contratada": "Razão social da prestadora/contratada",
    "Documento_Contratada": "NIF ou CNPJ da contratada",
    "Vigencia_Inicio": "Data de início no formato dd/MM/yyyy",
    "Vigencia_Fim": "Data de término no formato dd/MM/yyyy ou Indeterminado",
    "Valor_Total": "Valor numérico formatado (ex: 15000.00)",
    "Foro": "Cidade/Comarca eleita"
  }
}
```

### B) Faturas / Notas Fiscais
```json
{
  "system_instruction": "Você é um analista fiscal sênior responsável pela conferência de faturas e notas fiscais.",
  "prompt": "Extraia os dados de cabeçalho da fatura, impostos, valor total e resumo dos itens.",
  "schema": {
    "Numero_Fatura": "Número da fatura ou nota fiscal",
    "Data_Emissao": "Data de emissão no formato dd/MM/yyyy",
    "Data_Vencimento": "Data de vencimento no formato dd/MM/yyyy",
    "Fornecedor_Nome": "Razão social do emitente",
    "Fornecedor_NIF": "NIF ou CNPJ do emitente",
    "Valor_Liquido": "Valor líquido sem impostos (ex: 1000.00)",
    "Valor_IVA": "Valor total de impostos/IVA (ex: 230.00)",
    "Valor_Total": "Valor total da fatura (ex: 1230.00)",
    "Itens_Resumo": "Resumo dos itens separados por ponto e vírgula"
  }
}
```

### C) Guia de Remessa / Transporte
```json
{
  "system_instruction": "Você é um especialista em logística e conferência de guias de remessa e transporte.",
  "prompt": "Extraia o número da guia, data, remetente, destinatário, matrícula da viatura e resumo da mercadoria.",
  "schema": {
    "Numero_Guia": "Número da guia de remessa ou transporte",
    "Data_Guia": "Data de emissão no formato dd/MM/yyyy",
    "Remetente": "Nome ou razão social do remetente",
    "Destinatario": "Nome ou razão social do destinatário",
    "Local_Descarga": "Morada ou cidade de entrega",
    "Matricula_Viatura": "Matrícula/placa do veículo transportador",
    "Total_Volumes": "Quantidade total de volumes ou peso total",
    "Assinatura_Rececao": "SIM ou NAO indicando se a guia está assinada pelo recebedor"
  }
}
```

### D) Ficha de Intervenção Técnica / Formulário Manuscrito
```json
{
  "system_instruction": "Você é um especialista em OCR de documentos de campo e leitura de caligrafia manuscrita em fichas técnicas.",
  "prompt": "Leia cuidadosamente os campos impressos e manuscritos desta ficha de intervenção técnica.",
  "schema": {
    "Numero_OS": "Número da Ordem de Serviço ou Ficha",
    "Data_Intervencao": "Data do atendimento no formato dd/MM/yyyy",
    "Cliente": "Nome do cliente atendido",
    "Equipamento_Serie": "Modelo ou número de série do equipamento",
    "Tecnico_Responsavel": "Nome do técnico que executou o serviço",
    "Relatorio_Manuscrito": "Transcrição fiel das observações manuscritas sobre o defeito e solução aplicada",
    "Pecas_Substituidas": "Lista de peças utilizadas ou substituídas",
    "Status_Final": "Concluído, Pendente de Peça ou Em Aberto",
    "Assinado_Cliente": "SIM ou NAO indicando se há assinatura manuscrita no campo do cliente"
  }
}
```

---

## 5. Estrutura do Repositório

```text
.
├── .github/workflows/
│   └── deploy.yml             # Pipeline CI/CD GitHub Actions (deploy automático via SSH na Contabo)
├── scripts/
│   └── configure-nginx.sh     # Script idempotente que configura /ai-gateway/ no portal_nginx
├── src/
│   ├── server.ts              # Inicialização Fastify, limites multipart, handler global e graceful shutdown
│   ├── config.ts              # Leitura e validação tipada de variáveis de ambiente (.env)
│   ├── types.ts               # Interfaces TypeScript do contrato DocuWare <-> OpenAI
│   ├── auth.ts                # Autenticação time-safe (X-DocuWare-Token ou Authorization: Bearer)
│   ├── schema-builder.ts      # Parser resiliente de requestData e gerador de JSON Schema (strict: true)
│   ├── openai-service.ts      # Cliente OpenAI GPT-4o multimodal (PDF Base64) + Retry com Backoff Exponencial
│   ├── routes/
│   │   ├── extract.ts         # Endpoints POST (/extract, /ai-gateway/extract, /api/extract, /)
│   │   └── health.ts          # Endpoints GET (/health, /ai-gateway/health)
│   └── tests/
│       └── gateway.test.ts    # Testes unitários do parser, schema builder, PDF validator e auth
├── tests/
│   └── curl-examples.sh       # Exemplos prontos de chamadas curl para os cenários A, B, C e D
├── Dockerfile                 # Build Multi-Stage Node 22 Alpine (execução segura sob usuário não-root)
├── docker-compose.yml         # Deploy de produção com limites de recursos e reverse-proxy-network
├── .env.example               # Modelo de variáveis de ambiente
├── package.json
└── tsconfig.json
```

---

## 6. Testes via `curl`

### Verificar Healthcheck (HTTPS)
```bash
curl https://wp.processcloud.app/ai-gateway/health
```

### Enviar PDF + Instruções Dinâmicas (`requestData`)
```bash
curl -X POST "https://wp.processcloud.app/ai-gateway/extract" \
  -H "X-DocuWare-Token: docuware_token_2026" \
  -F "file=@./contrato.pdf;type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um auditor jurídico especialista em contratos.",
    "prompt": "Extraia as partes contratantes, vigência, valor total e foro.",
    "schema": {
      "Contratante": "Razão social da contratante",
      "Contratada": "Razão social da contratada",
      "Vigencia_Inicio": "Data no formato dd/MM/yyyy",
      "Valor_Total": "Valor numérico ou formatado",
      "Foro": "Cidade/Comarca"
    }
  }'
```

---

## 7. Deploy Contínuo Automático (GitHub Actions ➔ Contabo VPS)

Qualquer commit enviado (`git push`) para a branch `main` no repositório `https://github.com/cesarfois/Middleware-IA---Docuware.git` dispara automaticamente o workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

1. Conecta via SSH na VPS Contabo usando os GitHub Repository Secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`).
2. Atualiza o código em `/app/middleware-ia-docuware` preservando o arquivo `.env` de produção.
3. Reconstrói a imagem Docker (`docker compose build` + `docker compose up -d`).
4. Executa [`scripts/configure-nginx.sh`](scripts/configure-nginx.sh) garantindo que o `portal_nginx` encaminhe `/ai-gateway/` para `http://docuware-ai-gateway:3014`.
5. Valida o healthcheck tanto na porta local (`3014`) quanto via Nginx (`wp.processcloud.app/ai-gateway/health`).
