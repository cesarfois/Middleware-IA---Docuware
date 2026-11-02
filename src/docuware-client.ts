import { config } from './config.js';
import type {
  NormalizedTextshotRequest,
  TextshotCoordinateElement,
  TextshotErrorCode,
  TextshotPageResult,
  TextshotRequestBody,
  TextshotResponse,
} from './types.js';

export class DocuWareServiceError extends Error {
  public readonly code: TextshotErrorCode;
  public readonly statusCode: number;

  constructor(code: TextshotErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = 'DocuWareServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface CachedDocuWareSession {
  authHeader?: string;
  cookieHeader?: string;
  expiresAtMs: number;
}

interface DocuWareSectionMeta {
  id: string;
  sectionIndex: number;
  pageCount: number;
  textshotPath?: string;
}

const FILE_CABINET_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Valida e normaliza o payload de entrada do endpoint `POST /ai-gateway/textshot`.
 */
export function validateAndNormalizeTextshotRequest(
  body: unknown
): NormalizedTextshotRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DocuWareServiceError(
      'INVALID_REQUEST',
      400,
      'O corpo da requisição deve ser um objeto JSON contendo "fileCabinetId" e "documentId".'
    );
  }

  const raw = body as TextshotRequestBody;

  if (
    typeof raw.fileCabinetId !== 'string' ||
    !FILE_CABINET_ID_REGEX.test(raw.fileCabinetId.trim())
  ) {
    throw new DocuWareServiceError(
      'INVALID_REQUEST',
      400,
      'Parâmetro "fileCabinetId" ausente ou inválido. Deve ser o GUID/identificador válido do armário.'
    );
  }

  const parsedDocId =
    typeof raw.documentId === 'number'
      ? raw.documentId
      : typeof raw.documentId === 'string' && raw.documentId.trim() !== ''
        ? Number(raw.documentId.trim())
        : NaN;

  if (!Number.isInteger(parsedDocId) || parsedDocId <= 0) {
    throw new DocuWareServiceError(
      'INVALID_REQUEST',
      400,
      'Parâmetro "documentId" ausente ou inválido. Deve ser um número inteiro positivo.'
    );
  }

  const rawOptions = raw.options ?? {};
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw new DocuWareServiceError(
      'INVALID_REQUEST',
      400,
      'O campo opcional "options" deve ser um objeto JSON válido.'
    );
  }

  const output =
    rawOptions.output === 'pages' || rawOptions.output === 'full'
      ? rawOptions.output
      : 'text';

  if (
    rawOptions.output !== undefined &&
    !['text', 'pages', 'full'].includes(rawOptions.output)
  ) {
    throw new DocuWareServiceError(
      'INVALID_REQUEST',
      400,
      'Opção "options.output" inválida. Valores aceitos: "text", "pages" ou "full".'
    );
  }

  let maxCharacters: number | undefined;
  if (rawOptions.maxCharacters !== undefined && rawOptions.maxCharacters !== null) {
    if (
      typeof rawOptions.maxCharacters !== 'number' ||
      !Number.isInteger(rawOptions.maxCharacters) ||
      rawOptions.maxCharacters <= 0
    ) {
      throw new DocuWareServiceError(
        'INVALID_REQUEST',
        400,
        'Opção "options.maxCharacters" deve ser um número inteiro positivo.'
      );
    }
    maxCharacters = rawOptions.maxCharacters;
  }

  const includeCoordinates = Boolean(
    rawOptions.includeCoordinates || output === 'full'
  );
  const includePages = Boolean(
    rawOptions.includePages ||
      includeCoordinates ||
      output === 'pages' ||
      output === 'full'
  );
  const normalize =
    rawOptions.normalize === undefined ? true : Boolean(rawOptions.normalize);

  return {
    fileCabinetId: raw.fileCabinetId.trim(),
    documentId: parsedDocId,
    options: {
      includePages,
      includeCoordinates,
      normalize,
      output,
      maxCharacters,
    },
  };
}

/**
 * Normaliza o texto OCR preservando integralmente acentos e caracteres Unicode,
 * removendo apenas espaços horizontais redundantes e quebras de linha excessivas.
 */
export function normalizeOcrText(rawText: string): string {
  return rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Realiza o truncamento seguro de texto sem cortar palavras ao meio desnecessariamente.
 */
export function truncateTextWordSafe(
  text: string,
  maxCharacters?: number
): { text: string; truncated: boolean; originalTextLength: number } {
  const originalTextLength = text.length;

  if (!maxCharacters || originalTextLength <= maxCharacters) {
    return {
      text,
      truncated: false,
      originalTextLength,
    };
  }

  const sliceCandidate = text.slice(0, maxCharacters);
  // Se o próximo caractere na string original já é espaço ou quebra de linha, não cortou palavra
  const nextChar = text.charAt(maxCharacters);
  if (/\s/.test(nextChar)) {
    const trimmed = sliceCandidate.trimEnd();
    return {
      text: trimmed,
      truncated: true,
      originalTextLength,
    };
  }

  // Procura o último separador de palavra (espaço, quebra de linha ou pontuação) nos últimos 25% do limite
  const minCutIndex = Math.max(0, Math.floor(maxCharacters * 0.75));
  let cutIndex = -1;
  for (let i = sliceCandidate.length - 1; i >= minCutIndex; i--) {
    if (/\s/.test(sliceCandidate[i])) {
      cutIndex = i;
      break;
    }
  }

  const finalSlice =
    cutIndex > 0
      ? sliceCandidate.slice(0, cutIndex).trimEnd()
      : sliceCandidate;

  return {
    text: finalSlice,
    truncated: true,
    originalTextLength,
  };
}

/**
 * Executa tarefas assíncronas com limite máximo de concorrência, preservando a ordem original.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runnersCount = Math.min(Math.max(1, concurrency), items.length);
  const runners = Array.from({ length: runnersCount }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Extrai número finito de um campo numérico/string de coordenada, sem inventar valores.
 */
function toOptionalNumber(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Extrai elementos posicionais e texto de uma estrutura de página Textshot do DocuWare
 * (suporta JSON hierárquico Zones/Paragraphs/Lines/Words, JSON flat Items/Words e XML Textshot).
 */
export function extractPageContentFromDocuWarePayload(
  rawPage: unknown,
  normalize: boolean
): {
  text: string;
  coordinatesAvailable: boolean;
  elements: TextshotCoordinateElement[];
} {
  const elements: TextshotCoordinateElement[] = [];
  const linesText: string[] = [];

  // Caso 1: Resposta em string (texto puro ou XML do Textshot)
  if (typeof rawPage === 'string') {
    const trimmed = rawPage.trim();
    if (trimmed.startsWith('<')) {
      // Extração de tags <Wd ...>texto</Wd> ou <Word ...>texto</Word> em XML do DocuWare
      const lineRegex = /<(?:Ln|Line)\b[^>]*>([\s\S]*?)<\/(?:Ln|Line)>/gi;
      const wordRegex = /<(?:Wd|Word|W)\b([^>]*)>([\s\S]*?)<\/(?:Wd|Word|W)>/gi;
      let lineMatch: RegExpExecArray | null;

      while ((lineMatch = lineRegex.exec(trimmed)) !== null) {
        const lineContent = lineMatch[1];
        const lineWords: string[] = [];
        let wordMatch: RegExpExecArray | null;
        wordRegex.lastIndex = 0;

        while ((wordMatch = wordRegex.exec(lineContent)) !== null) {
          const attrs = wordMatch[1] || '';
          const wordText = wordMatch[2]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();

          if (!wordText) continue;
          lineWords.push(wordText);

          const left = toOptionalNumber(/\b(?:L|Left)="([^"]+)"/i.exec(attrs)?.[1]);
          const top = toOptionalNumber(/\b(?:T|Top)="([^"]+)"/i.exec(attrs)?.[1]);
          const width = toOptionalNumber(/\b(?:W|Width)="([^"]+)"/i.exec(attrs)?.[1]);
          const height = toOptionalNumber(/\b(?:H|Height)="([^"]+)"/i.exec(attrs)?.[1]);

          if (
            left !== undefined ||
            top !== undefined ||
            width !== undefined ||
            height !== undefined
          ) {
            elements.push({ text: wordText, left, top, width, height });
          }
        }

        if (lineWords.length > 0) {
          linesText.push(lineWords.join(' '));
        }
      }

      if (linesText.length === 0) {
        // Fallback XML sem tags <Ln>: extrai texto limpo de tags
        const stripped = trimmed
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
        if (stripped) linesText.push(stripped);
      }

      const combined = linesText.join('\n');
      return {
        text: normalize ? normalizeOcrText(combined) : combined,
        coordinatesAvailable: elements.length > 0,
        elements,
      };
    }

    return {
      text: normalize ? normalizeOcrText(rawPage) : rawPage,
      coordinatesAvailable: false,
      elements: [],
    };
  }

  if (!rawPage || typeof rawPage !== 'object') {
    return { text: '', coordinatesAvailable: false, elements: [] };
  }

  const pageObj = rawPage as Record<string, unknown>;

  // Coleta recursiva em estruturas JSON do DocuWare Platform (Zones -> Paragraphs -> Lines -> Words / Items)
  function visitNode(node: unknown): string[] {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) {
      const parts: string[] = [];
      for (const item of node) {
        parts.push(...visitNode(item));
      }
      return parts;
    }

    const obj = node as Record<string, unknown>;

    // Verifica se este nó é uma palavra/item folha com valor textual
    const rawWordVal =
      typeof obj.Value === 'string'
        ? obj.Value
        : typeof obj.Text === 'string'
          ? obj.Text
          : typeof obj.Content === 'string'
            ? obj.Content
            : typeof obj.V === 'string'
              ? obj.V
              : undefined;

    const hasChildContainers =
      Array.isArray(obj.Words) ||
      Array.isArray(obj.Wd) ||
      Array.isArray(obj.W) ||
      Array.isArray(obj.Lines) ||
      Array.isArray(obj.Ln) ||
      Array.isArray(obj.L) ||
      Array.isArray(obj.Paragraphs) ||
      Array.isArray(obj.P) ||
      Array.isArray(obj.Zones) ||
      Array.isArray(obj.TextZones) ||
      Array.isArray(obj.Items);

    // Extrai coordenadas reais caso existam no próprio nó ou em sub-objeto Box/Rectangle
    const box =
      obj.Box && typeof obj.Box === 'object'
        ? (obj.Box as Record<string, unknown>)
        : obj.Rectangle && typeof obj.Rectangle === 'object'
          ? (obj.Rectangle as Record<string, unknown>)
          : obj;

    const left = toOptionalNumber(box.L ?? box.Left ?? box.left ?? box.X ?? box.x);
    const top = toOptionalNumber(box.T ?? box.Top ?? box.top ?? box.Y ?? box.y);
    const width = toOptionalNumber(
      typeof box.W === 'number' || typeof box.W === 'string'
        ? box.W
        : (box.Width ?? box.width)
    );
    const height = toOptionalNumber(box.H ?? box.Height ?? box.height);
    const confidence = toOptionalNumber(obj.Confidence ?? obj.confidence);

    if (rawWordVal !== undefined && !hasChildContainers) {
      if (
        rawWordVal.trim().length > 0 &&
        (left !== undefined ||
          top !== undefined ||
          width !== undefined ||
          height !== undefined)
      ) {
        elements.push({
          text: rawWordVal,
          ...(left !== undefined ? { left } : {}),
          ...(top !== undefined ? { top } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
        });
      }
      return [rawWordVal];
    }

    // Se for uma Linha contendo Words / Wd / W
    const wordsContainer =
      obj.Words ??
      obj.Wd ??
      (Array.isArray(obj.W) ? obj.W : undefined);
    if (wordsContainer !== undefined) {
      const wordStrings = visitNode(wordsContainer)
        .map((w) => w.trim())
        .filter(Boolean);
      const lineStr =
        wordStrings.length > 0
          ? wordStrings.join(' ')
          : rawWordVal
            ? rawWordVal.trim()
            : '';
      if (lineStr) {
        if (
          elements.length === 0 &&
          (left !== undefined || top !== undefined || width !== undefined || height !== undefined)
        ) {
          elements.push({
            text: lineStr,
            ...(left !== undefined ? { left } : {}),
            ...(top !== undefined ? { top } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
          });
        }
        linesText.push(lineStr);
      }
      return [];
    }

    // Navega em containers de nível superior (Zones, TextZones, Paragraphs, Lines, Items)
    const childKeys = [
      'Zones',
      'TextZones',
      'Paragraphs',
      'P',
      'Lines',
      'Ln',
      'Items',
    ];
    let visitedChildren = false;
    for (const key of childKeys) {
      if (key in obj && obj[key] !== undefined) {
        visitedChildren = true;
        const childParts = visitNode(obj[key]);
        if (childParts.length > 0) {
          linesText.push(childParts.join(' '));
        }
      }
    }

    if (!visitedChildren && rawWordVal) {
      linesText.push(rawWordVal);
    }

    return [];
  }

  const rootParts = visitNode(pageObj);
  if (rootParts.length > 0) {
    linesText.push(rootParts.join(' '));
  }

  const rawJoined = linesText.join('\n');
  return {
    text: normalize ? normalizeOcrText(rawJoined) : rawJoined,
    coordinatesAvailable: elements.length > 0,
    elements,
  };
}

/**
 * Cliente para comunicação com a DocuWare Cloud 7.14 Platform REST API.
 * Reutiliza sessões/tokens válidos em memória e nunca envia documentos à OpenAI.
 */
export class DocuWarePlatformClient {
  private cachedSession: CachedDocuWareSession | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  public clearSessionCache(): void {
    this.cachedSession = null;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = config.docuwareTimeoutMs
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' ||
          err.name === 'TimeoutError' ||
          err.message.toLowerCase().includes('timeout') ||
          err.message.toLowerCase().includes('aborted'))
      ) {
        throw new DocuWareServiceError(
          'DOCUWARE_TIMEOUT',
          504,
          `Timeout ao comunicar com a DocuWare Platform API (${timeoutMs} ms excedidos).`
        );
      }
      throw new DocuWareServiceError(
        'DOCUWARE_API_ERROR',
        502,
        `Falha de rede ao comunicar com a DocuWare Platform API: ${err instanceof Error ? err.message : 'Erro desconhecido'}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Obtém ou reutiliza sessão autenticada na DocuWare Cloud 7.14 Platform REST API.
   * Suporta:
   * 1. Token Bearer pré-configurado (`DOCUWARE_BEARER_TOKEN` / `DOCUWARE_API_KEY`).
   * 2. OAuth2 via DocuWare Identity Service (`/Home/IdentityServiceInfo` -> `token_endpoint`).
   * 3. Fallback para `/Account/Logon` com cookie de sessão `.DWPLATFORMAUTH`.
   */
  public async getValidSession(
    forceRefresh = false
  ): Promise<{ session: CachedDocuWareSession; authTimeMs: number }> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedSession &&
      now < this.cachedSession.expiresAtMs - 60_000
    ) {
      return { session: this.cachedSession, authTimeMs: 0 };
    }

    const authStart = Date.now();

    // 1. Token Bearer estático ou de longa duração configurado no ambiente
    if (config.docuwareBearerToken && !config.docuwareUsername) {
      this.cachedSession = {
        authHeader: `Bearer ${config.docuwareBearerToken}`,
        expiresAtMs: now + 60 * 60 * 1000,
      };
      return {
        session: this.cachedSession,
        authTimeMs: Date.now() - authStart,
      };
    }

    if (!config.docuwareUsername || !config.docuwarePassword) {
      if (config.docuwareBearerToken) {
        this.cachedSession = {
          authHeader: `Bearer ${config.docuwareBearerToken}`,
          expiresAtMs: now + 60 * 60 * 1000,
        };
        return {
          session: this.cachedSession,
          authTimeMs: Date.now() - authStart,
        };
      }
      throw new DocuWareServiceError(
        'DOCUWARE_AUTH_FAILED',
        500,
        'Credenciais da DocuWare Platform API não configuradas no servidor (defina DOCUWARE_USERNAME/DOCUWARE_PASSWORD ou DOCUWARE_BEARER_TOKEN no .env).'
      );
    }

    const platformUrl = config.docuwarePlatformUrl;

    // 2. Tentativa via DocuWare Identity Service (OAuth2 ROPC oficial do DocuWare Cloud 7.14)
    try {
      const idInfoResp = await this.fetchWithTimeout(
        `${platformUrl}/Home/IdentityServiceInfo`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }
      );

      if (idInfoResp.ok) {
        const idInfo = (await idInfoResp.json()) as {
          IdentityServiceUrl?: string;
        };
        if (idInfo.IdentityServiceUrl) {
          const identityBase = idInfo.IdentityServiceUrl.replace(/\/+$/, '');
          const openIdResp = await this.fetchWithTimeout(
            `${identityBase}/.well-known/openid-configuration`,
            {
              method: 'GET',
              headers: { Accept: 'application/json' },
            }
          );

          if (openIdResp.ok) {
            const openIdConfig = (await openIdResp.json()) as {
              token_endpoint?: string;
            };
            const tokenEndpoint =
              openIdConfig.token_endpoint || `${identityBase}/connect/token`;

            const form = new URLSearchParams();
            form.set('grant_type', 'password');
            form.set('client_id', 'docuware.platform.net.client');
            form.set('scope', 'docuware.platform');
            form.set('username', config.docuwareUsername);
            form.set('password', config.docuwarePassword);

            const tokenResp = await this.fetchWithTimeout(tokenEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
              },
              body: form.toString(),
            });

            if (tokenResp.ok) {
              const tokenData = (await tokenResp.json()) as {
                access_token?: string;
                expires_in?: number;
              };
              if (tokenData.access_token) {
                const ttlMs = (tokenData.expires_in ?? 3600) * 1000;
                this.cachedSession = {
                  authHeader: `Bearer ${tokenData.access_token}`,
                  expiresAtMs: Date.now() + ttlMs,
                };
                return {
                  session: this.cachedSession,
                  authTimeMs: Date.now() - authStart,
                };
              }
            } else if (tokenResp.status === 400 || tokenResp.status === 401) {
              throw new DocuWareServiceError(
                'DOCUWARE_AUTH_FAILED',
                401,
                'Falha de autenticação na DocuWare Identity Service: credenciais inválidas ou acesso negado.'
              );
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof DocuWareServiceError) {
        throw err;
      }
      // Prossegue para fallback /Account/Logon caso IdentityServiceInfo não esteja ativo
    }

    // 3. Fallback para /Account/Logon (Cookie / Token de Sessão da Platform API)
    const logonForm = new URLSearchParams();
    logonForm.set('UserName', config.docuwareUsername);
    logonForm.set('Password', config.docuwarePassword);
    logonForm.set('RememberMe', 'false');
    if (config.docuwareHostId) {
      logonForm.set('HostID', config.docuwareHostId);
    }

    const logonResp = await this.fetchWithTimeout(
      `${platformUrl}/Account/Logon`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: logonForm.toString(),
      }
    );

    if (logonResp.status === 401 || logonResp.status === 403) {
      throw new DocuWareServiceError(
        'DOCUWARE_AUTH_FAILED',
        401,
        'Falha de autenticação em /Account/Logon na DocuWare Platform API: usuário ou senha inválidos.'
      );
    }

    if (!logonResp.ok) {
      throw new DocuWareServiceError(
        'DOCUWARE_AUTH_FAILED',
        502,
        `Erro inesperado ao autenticar na DocuWare Platform API (HTTP ${logonResp.status}).`
      );
    }

    const headersWithSetCookie = logonResp.headers as unknown as {
      getSetCookie?: () => string[];
    };
    const setCookies =
      typeof headersWithSetCookie.getSetCookie === 'function'
        ? headersWithSetCookie.getSetCookie()
        : logonResp.headers.get('set-cookie')
          ? [logonResp.headers.get('set-cookie') as string]
          : [];

    const cookiePairs = setCookies
      .map((c) => c.split(';')[0]?.trim())
      .filter(Boolean);

    let extractedToken: string | undefined;
    try {
      const bodyText = await logonResp.text();
      if (bodyText.trim().startsWith('{')) {
        const parsed = JSON.parse(bodyText) as {
          Token?: string;
          access_token?: string;
        };
        extractedToken = parsed.Token || parsed.access_token;
      } else if (bodyText.trim().length > 0 && !bodyText.trim().startsWith('<')) {
        extractedToken = bodyText.trim().replace(/^"|"$/g, '');
      }
    } catch {
      // Ignora erro de parse do corpo se cookies já foram recebidos
    }

    if (!extractedToken && cookiePairs.length === 0) {
      throw new DocuWareServiceError(
        'DOCUWARE_AUTH_FAILED',
        401,
        'A DocuWare Platform API não retornou token nem cookies de sessão válidos.'
      );
    }

    this.cachedSession = {
      ...(extractedToken ? { authHeader: `Bearer ${extractedToken}` } : {}),
      ...(cookiePairs.length > 0 ? { cookieHeader: cookiePairs.join('; ') } : {}),
      expiresAtMs: Date.now() + 25 * 60 * 1000,
    };

    return {
      session: this.cachedSession,
      authTimeMs: Date.now() - authStart,
    };
  }

  /**
   * Executa uma requisição GET autenticada na DocuWare Platform API,
   * renovando automaticamente a sessão 1 vez caso receba HTTP 401.
   */
  private async authenticatedGet(
    pathOrUrl: string,
    session: CachedDocuWareSession
  ): Promise<{ response: Response; extraAuthTimeMs: number }> {
    const platformUrl = config.docuwarePlatformUrl;
    let targetUrl: string;

    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      // Garante que links de navegação pertencem ao mesmo host configurado no servidor
      const allowedHost = new URL(platformUrl).host.toLowerCase();
      const candidateHost = new URL(pathOrUrl).host.toLowerCase();
      if (candidateHost !== allowedHost) {
        throw new DocuWareServiceError(
          'DOCUWARE_API_ERROR',
          502,
          'Link de navegação retornado pela API aponta para um host externo não autorizado.'
        );
      }
      targetUrl = pathOrUrl;
    } else if (pathOrUrl.startsWith('/DocuWare/Platform/')) {
      const origin = new URL(platformUrl).origin;
      targetUrl = `${origin}${pathOrUrl}`;
    } else {
      const cleanRel = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
      targetUrl = `${platformUrl}${cleanRel}`;
    }

    const buildHeaders = (s: CachedDocuWareSession): Record<string, string> => ({
      Accept: 'application/json, application/xml;q=0.9, text/plain;q=0.8',
      ...(s.authHeader ? { Authorization: s.authHeader } : {}),
      ...(s.cookieHeader ? { Cookie: s.cookieHeader } : {}),
    });

    const firstResp = await this.fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: buildHeaders(session),
    });

    if (firstResp.status !== 401) {
      return { response: firstResp, extraAuthTimeMs: 0 };
    }

    // Sessão expirou prematuramente: reautentica uma única vez
    const refreshed = await this.getValidSession(true);
    const secondResp = await this.fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: buildHeaders(refreshed.session),
    });

    return { response: secondResp, extraAuthTimeMs: refreshed.authTimeMs };
  }

  /**
   * Consulta os metadados do documento e retorna a lista ordenada de todas as suas seções.
   */
  private async fetchDocumentSections(
    fileCabinetId: string,
    documentId: number,
    session: CachedDocuWareSession
  ): Promise<{ sections: DocuWareSectionMeta[]; extraAuthTimeMs: number }> {
    const docPath = `/FileCabinets/${encodeURIComponent(fileCabinetId)}/Documents/${documentId}`;
    const { response, extraAuthTimeMs } = await this.authenticatedGet(
      docPath,
      session
    );

    if (response.status === 404) {
      throw new DocuWareServiceError(
        'DOCUMENT_NOT_FOUND',
        404,
        `Documento ${documentId} não encontrado no armário "${fileCabinetId}".`
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new DocuWareServiceError(
        response.status === 401 ? 'DOCUWARE_AUTH_FAILED' : 'DOCUMENT_NOT_FOUND',
        response.status,
        `Sem permissão ou acesso negado ao consultar o documento ${documentId} no armário "${fileCabinetId}".`
      );
    }

    if (!response.ok) {
      throw new DocuWareServiceError(
        'DOCUWARE_API_ERROR',
        502,
        `Erro ao consultar metadados do documento ${documentId} na DocuWare Platform API (HTTP ${response.status}).`
      );
    }

    let docData: Record<string, unknown>;
    try {
      docData = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new DocuWareServiceError(
        'DOCUWARE_API_ERROR',
        502,
        'Resposta inválida ao decodificar JSON de metadados do documento na DocuWare Platform API.'
      );
    }

    const rawSectionsContainer = docData.Sections ?? docData.sections;
    const rawSectionsList: unknown[] = Array.isArray(rawSectionsContainer)
      ? rawSectionsContainer
      : rawSectionsContainer &&
          typeof rawSectionsContainer === 'object' &&
          Array.isArray((rawSectionsContainer as Record<string, unknown>).Section)
        ? ((rawSectionsContainer as Record<string, unknown>).Section as unknown[])
        : [];

    if (rawSectionsList.length === 0) {
      throw new DocuWareServiceError(
        'TEXTSHOT_NOT_AVAILABLE',
        422,
        `O documento ${documentId} foi localizado, mas não possui seções de arquivo associadas para extração de Textshot.`
      );
    }

    const sections: DocuWareSectionMeta[] = [];

    for (let idx = 0; idx < rawSectionsList.length; idx++) {
      const sec = rawSectionsList[idx] as Record<string, unknown>;
      const secId = String(sec.Id ?? sec.id ?? '').trim();
      if (!secId) continue;

      const rawPageCount = Number(sec.PageCount ?? sec.pageCount ?? 0);
      const pageCount =
        Number.isInteger(rawPageCount) && rawPageCount > 0 ? rawPageCount : 1;

      // Verifica se os Links da seção já trazem a rota exata para o relation "textshot"
      let textshotPath: string | undefined;
      const rawLinks =
        sec.Links ??
        (sec.Links && typeof sec.Links === 'object'
          ? (sec.Links as Record<string, unknown>).Link
          : undefined);
      const linksArray = Array.isArray(rawLinks) ? rawLinks : [];

      for (const link of linksArray) {
        if (link && typeof link === 'object') {
          const lObj = link as Record<string, unknown>;
          const rel = String(lObj.rel ?? lObj.Rel ?? '').toLowerCase();
          const href = String(lObj.href ?? lObj.Href ?? '').trim();
          if ((rel === 'textshot' || rel === 'textannotation') && href) {
            textshotPath = href;
            break;
          }
        }
      }

      sections.push({
        id: secId,
        sectionIndex: idx + 1,
        pageCount,
        textshotPath,
      });
    }

    if (sections.length === 0) {
      throw new DocuWareServiceError(
        'TEXTSHOT_NOT_AVAILABLE',
        422,
        `O documento ${documentId} não possui identificadores de seção válidos.`
      );
    }

    return { sections, extraAuthTimeMs };
  }

  /**
   * Recupera todas as páginas de Textshot de uma seção, preservando a ordem exata das páginas.
   * Primeiro utiliza o endpoint de seção `/Sections/{sectionId}/Textshot`; caso a seção possua mais páginas
   * do que o retornado ou exija chamada por página, consulta `/TextshotPage` com concorrência controlada.
   */
  private async fetchSectionPages(
    fileCabinetId: string,
    section: DocuWareSectionMeta,
    normalize: boolean,
    includeCoordinates: boolean,
    session: CachedDocuWareSession
  ): Promise<{
    pages: Array<{
      sectionId: string;
      sectionIndex: number;
      pageNumber: number;
      text: string;
      coordinatesAvailable: boolean;
      elements?: TextshotCoordinateElement[];
    }>;
    extraAuthTimeMs: number;
  }> {
    let extraAuthTimeMs = 0;
    const defaultSectionPath = `/FileCabinets/${encodeURIComponent(fileCabinetId)}/Sections/${encodeURIComponent(section.id)}/Textshot`;
    const targetPath = section.textshotPath || defaultSectionPath;

    const { response, extraAuthTimeMs: authDelta } =
      await this.authenticatedGet(targetPath, session);
    extraAuthTimeMs += authDelta;

    if (response.status === 404) {
      throw new DocuWareServiceError(
        'TEXTSHOT_NOT_AVAILABLE',
        422,
        `Textshot ainda não disponível para a seção "${section.id}".`
      );
    }

    if (response.ok) {
      const contentType = (
        response.headers.get('content-type') || ''
      ).toLowerCase();
      const rawBody = await response.text();

      if (rawBody.trim().length > 0) {
        if (contentType.includes('json') || rawBody.trim().startsWith('{')) {
          let parsedJson: Record<string, unknown> | null = null;
          try {
            parsedJson = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            parsedJson = null;
          }

          if (parsedJson) {
            const pagesContainer = parsedJson.Pages ?? parsedJson.pages;
            const rawPagesList: unknown[] = Array.isArray(pagesContainer)
              ? pagesContainer
              : pagesContainer &&
                  typeof pagesContainer === 'object' &&
                  Array.isArray(
                    (pagesContainer as Record<string, unknown>).Page
                  )
                ? ((pagesContainer as Record<string, unknown>)
                    .Page as unknown[])
                : [];

            // Se o endpoint de seção retornou todas as páginas esperadas (ou se não precisamos buscar páginas faltantes)
            if (
              rawPagesList.length >= section.pageCount &&
              rawPagesList.length > 0
            ) {
              const extractedPages = rawPagesList.map((rawPage, idx) => {
                const parsedPage = extractPageContentFromDocuWarePayload(
                  rawPage,
                  normalize
                );
                const pageNumObj =
                  rawPage && typeof rawPage === 'object'
                    ? (rawPage as Record<string, unknown>)
                    : {};
                const explicitPageNum = Number(
                  pageNumObj.PageNumber ?? pageNumObj.pageNumber ?? idx + 1
                );

                return {
                  sectionId: section.id,
                  sectionIndex: section.sectionIndex,
                  pageNumber:
                    Number.isInteger(explicitPageNum) && explicitPageNum > 0
                      ? explicitPageNum
                      : idx + 1,
                  text: parsedPage.text,
                  coordinatesAvailable: parsedPage.coordinatesAvailable,
                  ...(includeCoordinates
                    ? { elements: parsedPage.elements }
                    : {}),
                };
              });

              extractedPages.sort((a, b) => a.pageNumber - b.pageNumber);
              return { pages: extractedPages, extraAuthTimeMs };
            }

            // Caso o objeto JSON represente diretamente uma única página e section.pageCount === 1
            if (rawPagesList.length === 0 && section.pageCount === 1) {
              const singlePage = extractPageContentFromDocuWarePayload(
                parsedJson,
                normalize
              );
              if (singlePage.text.trim().length > 0) {
                return {
                  pages: [
                    {
                      sectionId: section.id,
                      sectionIndex: section.sectionIndex,
                      pageNumber: 1,
                      text: singlePage.text,
                      coordinatesAvailable: singlePage.coordinatesAvailable,
                      ...(includeCoordinates
                        ? { elements: singlePage.elements }
                        : {}),
                    },
                  ],
                  extraAuthTimeMs,
                };
              }
            }
          }
        } else if (rawBody.trim().startsWith('<')) {
          // Resposta XML com múltiplas tags <Page> ou página única
          const pageTagRegex = /<Page\b[^>]*>([\s\S]*?)<\/Page>/gi;
          const xmlPages: string[] = [];
          let match: RegExpExecArray | null;
          while ((match = pageTagRegex.exec(rawBody)) !== null) {
            xmlPages.push(match[0]);
          }

          if (xmlPages.length >= section.pageCount && xmlPages.length > 0) {
            const extractedXmlPages = xmlPages.map((xmlPage, idx) => {
              const parsed = extractPageContentFromDocuWarePayload(
                xmlPage,
                normalize
              );
              return {
                sectionId: section.id,
                sectionIndex: section.sectionIndex,
                pageNumber: idx + 1,
                text: parsed.text,
                coordinatesAvailable: parsed.coordinatesAvailable,
                ...(includeCoordinates ? { elements: parsed.elements } : {}),
              };
            });
            return { pages: extractedXmlPages, extraAuthTimeMs };
          }
        }
      }
    }

    // Fallback ou complementação multipágina via `/TextshotPage?page={page}&flat=true&normalize=true`
    const pageNumbers = Array.from(
      { length: section.pageCount },
      (_, idx) => idx
    );

    const fetchedPages = await mapWithConcurrency(
      pageNumbers,
      config.docuwareMaxConcurrency,
      async (pageZeroIndex) => {
        const pagePath = `/FileCabinets/${encodeURIComponent(fileCabinetId)}/Sections/${encodeURIComponent(section.id)}/TextshotPage?page=${pageZeroIndex}&flat=true&normalize=${normalize ? 'true' : 'false'}`;
        const { response: pageResp, extraAuthTimeMs: pageAuthDelta } =
          await this.authenticatedGet(pagePath, session);
        extraAuthTimeMs += pageAuthDelta;

        if (pageResp.status === 404) {
          throw new DocuWareServiceError(
            'TEXTSHOT_NOT_AVAILABLE',
            422,
            `Textshot não encontrado para a página ${pageZeroIndex + 1} da seção "${section.id}".`
          );
        }

        if (!pageResp.ok) {
          throw new DocuWareServiceError(
            'DOCUWARE_API_ERROR',
            502,
            `Erro ao recuperar TextshotPage (página ${pageZeroIndex + 1}, seção "${section.id}"): HTTP ${pageResp.status}.`
          );
        }

        const pageBodyText = await pageResp.text();
        let rawPayload: unknown = pageBodyText;
        if (pageBodyText.trim().startsWith('{')) {
          try {
            rawPayload = JSON.parse(pageBodyText);
          } catch {
            rawPayload = pageBodyText;
          }
        }

        const parsed = extractPageContentFromDocuWarePayload(
          rawPayload,
          normalize
        );

        return {
          sectionId: section.id,
          sectionIndex: section.sectionIndex,
          pageNumber: pageZeroIndex + 1,
          text: parsed.text,
          coordinatesAvailable: parsed.coordinatesAvailable,
          ...(includeCoordinates ? { elements: parsed.elements } : {}),
        };
      }
    );

    fetchedPages.sort((a, b) => a.pageNumber - b.pageNumber);
    return { pages: fetchedPages, extraAuthTimeMs };
  }

  /**
   * Fluxo completo de recuperação do Textshot de um documento no DocuWare Cloud 7.14:
   * 1. Autentica (ou reutiliza sessão em cache).
   * 2. Consulta metadados do documento e descobre todas as seções.
   * 3. Recupera os Textshots de cada seção/página preservando a ordem exata.
   * 4. Consolida, valida limites e retorna o JSON com métricas de tempo detalhadas.
   */
  public async retrieveDocumentTextshot(
    request: NormalizedTextshotRequest
  ): Promise<TextshotResponse> {
    const overallStart = Date.now();

    // 1. Autenticação
    const { session, authTimeMs: initialAuthTimeMs } =
      await this.getValidSession(false);
    let totalAuthTimeMs = initialAuthTimeMs;

    // 2. Consulta de metadados do documento e seções
    const metadataStart = Date.now();
    const { sections, extraAuthTimeMs: metaAuthDelta } =
      await this.fetchDocumentSections(
        request.fileCabinetId,
        request.documentId,
        session
      );
    totalAuthTimeMs += metaAuthDelta;
    const metadataTimeMs = Math.max(
      0,
      Date.now() - metadataStart - metaAuthDelta
    );

    // 3. Recuperação dos Textshots de cada seção (com limite de concorrência e ordem preservada)
    const textshotStart = Date.now();
    const currentSession = this.cachedSession || session;

    const sectionResults = await mapWithConcurrency(
      sections,
      config.docuwareMaxConcurrency,
      async (sec) =>
        this.fetchSectionPages(
          request.fileCabinetId,
          sec,
          request.options.normalize,
          request.options.includeCoordinates,
          currentSession
        )
    );

    let extraTextshotAuthMs = 0;
    const orderedPages: TextshotPageResult[] = [];
    let globalPageCounter = 0;

    for (const secResult of sectionResults) {
      extraTextshotAuthMs += secResult.extraAuthTimeMs;
      for (const page of secResult.pages) {
        globalPageCounter++;
        orderedPages.push({
          sectionId: page.sectionId,
          sectionIndex: page.sectionIndex,
          pageNumber: page.pageNumber,
          globalPageNumber: globalPageCounter,
          text: page.text,
          textLength: page.text.length,
          coordinatesAvailable: page.coordinatesAvailable,
          ...(request.options.includeCoordinates
            ? { elements: page.elements ?? [] }
            : {}),
        });
      }
    }

    totalAuthTimeMs += extraTextshotAuthMs;
    const textshotTimeMs = Math.max(
      0,
      Date.now() - textshotStart - extraTextshotAuthMs
    );

    if (orderedPages.length === 0) {
      throw new DocuWareServiceError(
        'TEXTSHOT_NOT_AVAILABLE',
        422,
        `O documento ${request.documentId} foi localizado, mas não possui páginas de Textshot disponíveis.`
      );
    }

    const consolidatedFullText = orderedPages
      .map((p) => p.text)
      .filter((t) => t.trim().length > 0)
      .join('\n\n');

    // Distingue Textshot ausente/não processado: não retorna string vazia fingindo sucesso
    if (consolidatedFullText.trim().length === 0) {
      throw new DocuWareServiceError(
        'TEXTSHOT_NOT_AVAILABLE',
        422,
        `O documento ${request.documentId} foi encontrado, mas o Textshot está vazio ou ainda não foi processado pelo OCR do DocuWare.`
      );
    }

    if (consolidatedFullText.length > config.docuwareMaxTextshotChars) {
      throw new DocuWareServiceError(
        'TEXT_TOO_LARGE',
        422,
        `O texto extraído (${consolidatedFullText.length} caracteres) excede o limite operacional configurado (${config.docuwareMaxTextshotChars} caracteres). Utilize "options.maxCharacters" ou ajuste DOCUWARE_MAX_TEXTSHOT_CHARS.`
      );
    }

    const {
      text: finalText,
      truncated,
      originalTextLength,
    } = truncateTextWordSafe(
      consolidatedFullText,
      request.options.maxCharacters
    );

    const totalTimeMs = Date.now() - overallStart;

    const responsePayload: TextshotResponse = {
      success: true,
      documentId: request.documentId,
      fileCabinetId: request.fileCabinetId,
      source: 'docuware_textshot',
      sectionCount: sections.length,
      pageCount: orderedPages.length,
      text: finalText,
      textLength: finalText.length,
      originalTextLength,
      truncated,
      status: 'completed',
      processingTimeMs: totalTimeMs,
      timings: {
        authTimeMs: totalAuthTimeMs,
        metadataTimeMs,
        textshotTimeMs,
        totalTimeMs,
      },
      ...(request.options.includePages ? { pages: orderedPages } : {}),
    };

    return responsePayload;
  }
}

export const defaultDocuWareClient = new DocuWarePlatformClient();

