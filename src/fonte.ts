// Busca e cache dos dados públicos do Flaviômetro.
//
// O site não tem API. Os dados vêm de duas fontes:
//   1. A página inicial, que embute `window.ELEITOS` (cadastro dos políticos:
//      nome, cargo, UF, partido...) e `window.VERSAO` (usada como ?v= no feed).
//   2. `dados/feed.json`, que traz todos os posts monitorados de uma vez.

import { EnvHttpProxyAgent, ProxyAgent, Socks5ProxyAgent, fetch, type Dispatcher } from "undici";

export const BASE_URL = (process.env.FLAVIOMETRO_BASE_URL ?? "https://flaviometro.com").replace(/\/+$/, "");
const TTL_MS = Number(process.env.FLAVIOMETRO_CACHE_TTL_SEGUNDOS ?? 300) * 1000;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "flaviometro-mcp/0.1 (cliente MCP local, não oficial)";

export type Rede = "ig" | "fb" | "x" | "th" | "yt" | "tt" | "kw" | "tg";
export type Cargo = "gov" | "sen" | "fed" | "est" | "pref";
export type Situacao = "eleito" | "2t" | "mandato";

/** [rede, usuário, url, marcador opcional (ex.: "equipe")] */
export type ContaRede = [string, string, string, string?];

export interface Pessoa {
  sq: string;
  nome: string;
  n: string;
  uf: string;
  cargo: Cargo;
  sit: Situacao;
  g: "M" | "F";
  votos: number;
  partido: string;
  redes: ContaRede[];
  mun?: string;
}

export interface Post {
  id: string;
  sq: string;
  t: number;
  rede: Rede;
  /** 0 = não citou, 1 = citou o Flávio, 2 = pediu voto */
  flavio: 0 | 1 | 2;
  tema: string | null;
  conta?: string;
  url?: string;
  formato?: string;
  tipo?: string;
  texto?: string;
  views?: number | null;
  likes?: number | null;
  comentarios?: number | null;
  compartilhamentos?: number | null;
  thumb?: string;
  /** 1 quando a citação foi detectada na fala do vídeo */
  fala?: 1;
  /** Trecho transcrito do vídeo em que a citação aparece */
  trecho?: string;
  v?: number;
}

export interface Feed {
  gerado: number;
  desde: number;
  versao: string;
  temas: unknown[];
  contas: Record<string, ContaRede[]>;
  posts: Post[];
  /** sq -> [início, fim] da janela monitorada (timestamps em ms) */
  cobertura: Record<string, [number, number]>;
}

export interface Dados {
  feed: Feed;
  pessoas: Pessoa[];
  pessoasPorSq: Map<string, Pessoa>;
  cadastroGerado: string;
  versaoSite: string;
  carregadoEm: number;
}

// ---------- proxy ----------
//
// FLAVIOMETRO_PROXY tem prioridade: http://, https://, socks5:// ou "desligado".
// Sem ela, vale o padrão HTTPS_PROXY / HTTP_PROXY / NO_PROXY do sistema.

const DESLIGADO = new Set(["desligado", "off", "none", "nenhum", "0", "false"]);
const envProxy = (nome: string) => process.env[nome] ?? process.env[nome.toLowerCase()];

/** Esconde usuário e senha ao exibir a URL do proxy. */
const mascarar = (url: string) => url.replace(/\/\/[^@/]*@/, "//***@");

interface ConfigProxy {
  dispatcher?: Dispatcher;
  descricao: string;
  /** Erro de configuração: o servidor sobe, mas cada download falha com esta mensagem. */
  erro?: string;
}

function criarDispatcher(): ConfigProxy {
  const explicito = process.env.FLAVIOMETRO_PROXY?.trim();

  if (explicito && DESLIGADO.has(explicito.toLowerCase())) return { descricao: "desligado (FLAVIOMETRO_PROXY)" };

  if (explicito) {
    let url: URL;
    try {
      url = new URL(explicito);
    } catch {
      return {
        descricao: "inválido",
        erro: `FLAVIOMETRO_PROXY inválido: "${mascarar(explicito)}". Exemplo: http://usuario:senha@host:3128`,
      };
    }
    if (url.protocol === "socks5:" || url.protocol === "socks:")
      return { dispatcher: new Socks5ProxyAgent(explicito), descricao: `SOCKS5 ${mascarar(explicito)}` };
    if (url.protocol === "http:" || url.protocol === "https:")
      return { dispatcher: new ProxyAgent(explicito), descricao: `HTTP ${mascarar(explicito)}` };
    return {
      descricao: "inválido",
      erro: `FLAVIOMETRO_PROXY usa um protocolo não suportado (${url.protocol}). Use http://, https:// ou socks5://.`,
    };
  }

  const sistema = envProxy("HTTPS_PROXY") ?? envProxy("HTTP_PROXY");
  if (sistema) {
    const excecoes = envProxy("NO_PROXY");
    return {
      dispatcher: new EnvHttpProxyAgent(),
      descricao: `HTTP ${mascarar(sistema)} (variáveis do sistema${excecoes ? `, exceto NO_PROXY=${excecoes}` : ""})`,
    };
  }

  return { descricao: "nenhum (conexão direta)" };
}

const proxy = criarDispatcher();
export const DESCRICAO_PROXY = proxy.descricao;

let cache: Dados | null = null;
let emAndamento: Promise<Dados> | null = null;

/** GET com User-Agent, timeout e o proxy configurado. Lança erro descritivo em falha. */
export async function baixar(url: string, timeoutMs = TIMEOUT_MS) {
  if (proxy.erro) throw new Error(proxy.erro);
  let resp;
  try {
    resp = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: proxy.dispatcher,
    });
  } catch (e) {
    const causa = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
    const viaProxy = proxy.dispatcher ? ` via proxy ${proxy.descricao}` : "";
    throw new Error(`Não consegui acessar ${url}${viaProxy}: ${causa}`);
  }
  if (!resp.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${resp.status}`);
  return resp;
}

/** Recorta o literal JS que vem depois de `marcador` (ex.: `window.ELEITOS=`). */
function recortarLiteral(html: string, marcador: string): string {
  const inicio = html.indexOf(marcador);
  if (inicio < 0) throw new Error(`Não encontrei "${marcador}" na página. O site pode ter mudado.`);
  let i = inicio + marcador.length;
  const comeco = i;
  let profundidade = 0;
  let aspas: string | null = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (aspas) {
      if (c === "\\") i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") aspas = c;
    else if (c === "{" || c === "[") profundidade++;
    else if (c === "}" || c === "]") {
      profundidade--;
      if (profundidade === 0) return html.slice(comeco, i + 1);
    }
  }
  throw new Error(`Literal "${marcador}" incompleto na página.`);
}

/**
 * Converte o objeto JS embutido (chaves sem aspas, strings com aspas duplas)
 * em JSON, sem executar código da página.
 */
function literalParaJson(literal: string): unknown {
  const json = literal.replace(/("(?:[^"\\]|\\.)*")|([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, (m, str, sep, chave) =>
    str ? str : `${sep}"${chave}":`,
  );
  return JSON.parse(json);
}

async function carregar(): Promise<Dados> {
  const html = await (await baixar(`${BASE_URL}/`)).text();

  const versaoSite = /window\.VERSAO\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? process.env.FLAVIOMETRO_VERSAO ?? "";
  const caminhoFeed = /window\.AO_VIVO\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? "dados/feed.json";

  const eleitos = literalParaJson(recortarLiteral(html, "window.ELEITOS=")) as { gerado: string; pessoas: Pessoa[] };

  const urlFeed = `${BASE_URL}/${caminhoFeed.replace(/^\.?\//, "")}${versaoSite ? `?v=${encodeURIComponent(versaoSite)}` : ""}`;
  const feed = (await (await baixar(urlFeed)).json()) as Feed;
  if (!Array.isArray(feed.posts)) throw new Error("Formato inesperado do feed: campo `posts` ausente.");

  const pessoas = eleitos.pessoas.map((p) => ({ ...p, redes: feed.contas[p.sq] ?? p.redes }));
  feed.posts.sort((a, b) => b.t - a.t);

  return {
    feed,
    pessoas,
    pessoasPorSq: new Map(pessoas.map((p) => [p.sq, p])),
    cadastroGerado: eleitos.gerado,
    versaoSite,
    carregadoEm: Date.now(),
  };
}

/** Retorna os dados em cache, baixando de novo se passaram do TTL ou se `forcar`. */
export async function obterDados(forcar = false): Promise<Dados> {
  if (!forcar && cache && Date.now() - cache.carregadoEm < TTL_MS) return cache;
  if (!emAndamento) {
    emAndamento = carregar()
      .then((d) => (cache = d))
      .finally(() => (emAndamento = null));
  }
  try {
    return await emAndamento;
  } catch (erro) {
    // Se já temos uma versão anterior, melhor devolver dado velho do que nada.
    if (cache) return cache;
    throw erro;
  }
}
