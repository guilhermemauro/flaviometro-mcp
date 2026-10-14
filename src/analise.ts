// Agregações e formatação em cima dos dados brutos do feed.

import type { Cargo, Dados, Pessoa, Post, Rede, Situacao } from "./fonte.js";

export const ROTULO_CARGO: Record<Cargo, string> = {
  gov: "Governador(a)",
  sen: "Senador(a)",
  fed: "Deputado(a) federal",
  est: "Deputado(a) estadual",
  pref: "Prefeito(a)",
};

export const ROTULO_SITUACAO: Record<Situacao, string> = {
  eleito: "Eleito(a) em 2026",
  "2t": "Disputa o 2º turno",
  mandato: "Em mandato",
};

export const ROTULO_REDE: Record<Rede, string> = {
  ig: "Instagram",
  fb: "Facebook",
  x: "X (Twitter)",
  th: "Threads",
  yt: "YouTube",
  tt: "TikTok",
  kw: "Kwai",
  tg: "Telegram",
};

export const ROTULO_NIVEL = ["Não citou", "Citou o Flávio", "Pediu voto"] as const;

const FUSO = "America/Sao_Paulo";
const fmtData = new Intl.DateTimeFormat("pt-BR", {
  timeZone: FUSO,
  dateStyle: "short",
  timeStyle: "short",
});

export const dataBR = (t: number | null | undefined) => (t ? fmtData.format(new Date(t)) : null);

export const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const interacoes = (p: Post) => (p.likes ?? 0) + (p.comentarios ?? 0) + (p.compartilhamentos ?? 0);

/** Converte "2026-10-10" ou ISO completo em timestamp. Datas sem hora valem a partir de 00:00 de Brasília. */
export function parseData(valor: string | undefined, fimDoDia = false): number | undefined {
  if (!valor) return undefined;
  const soData = /^\d{4}-\d{2}-\d{2}$/.test(valor);
  const t = Date.parse(soData ? `${valor}T${fimDoDia ? "23:59:59.999" : "00:00:00"}-03:00` : valor);
  if (Number.isNaN(t)) throw new Error(`Data inválida: "${valor}". Use AAAA-MM-DD ou ISO 8601.`);
  return t;
}

export interface FiltroPessoa {
  nome?: string;
  uf?: string;
  cargo?: Cargo;
  partido?: string;
  situacao?: Situacao;
  municipio?: string;
}

export function filtrarPessoas(pessoas: Pessoa[], f: FiltroPessoa): Pessoa[] {
  const nome = f.nome && normalizar(f.nome);
  const mun = f.municipio && normalizar(f.municipio);
  const partido = f.partido && normalizar(f.partido);
  return pessoas.filter(
    (p) =>
      (!nome || normalizar(p.nome).includes(nome) || p.sq === f.nome) &&
      (!f.uf || p.uf === f.uf.toUpperCase()) &&
      (!f.cargo || p.cargo === f.cargo) &&
      (!partido || normalizar(p.partido) === partido) &&
      (!f.situacao || p.sit === f.situacao) &&
      (!mun || (p.mun !== undefined && normalizar(p.mun).includes(mun))),
  );
}

export interface Estatistica {
  posts: number;
  citou: number;
  pediuVoto: number;
  views: number;
  likes: number;
  interacoes: number;
  primeiraCitacao: number | null;
  ultimaCitacao: number | null;
  ultimoPost: number | null;
}

const vazia = (): Estatistica => ({
  posts: 0,
  citou: 0,
  pediuVoto: 0,
  views: 0,
  likes: 0,
  interacoes: 0,
  primeiraCitacao: null,
  ultimaCitacao: null,
  ultimoPost: null,
});

/** Estatísticas por político (sq), considerando só os posts dentro da janela. */
export function estatisticasPorPessoa(posts: Post[], desde?: number, ate?: number): Map<string, Estatistica> {
  const m = new Map<string, Estatistica>();
  for (const p of posts) {
    if ((desde && p.t < desde) || (ate && p.t > ate)) continue;
    const e = m.get(p.sq) ?? vazia();
    m.set(p.sq, e);
    e.posts++;
    e.ultimoPost = Math.max(e.ultimoPost ?? 0, p.t);
    if (p.flavio >= 1) {
      e.citou++;
      if (p.flavio === 2) e.pediuVoto++;
      e.views += p.views ?? 0;
      e.likes += p.likes ?? 0;
      e.interacoes += interacoes(p);
      e.primeiraCitacao = Math.min(e.primeiraCitacao ?? Infinity, p.t);
      e.ultimaCitacao = Math.max(e.ultimaCitacao ?? 0, p.t);
    }
  }
  return m;
}

export type StatusFlavio = "pediu_voto" | "citou" | "nao_citou" | "sem_posts";

export function statusDe(e: Estatistica | undefined): StatusFlavio {
  if (!e || e.posts === 0) return "sem_posts";
  if (e.pediuVoto > 0) return "pediu_voto";
  if (e.citou > 0) return "citou";
  return "nao_citou";
}

export const ROTULO_STATUS: Record<StatusFlavio, string> = {
  pediu_voto: "Pediu voto no Flávio",
  citou: "Citou o Flávio (sem pedir voto)",
  nao_citou: "Postou, mas não citou o Flávio",
  sem_posts: "Nenhum post captado no período",
};

export function resumoPessoa(p: Pessoa, e: Estatistica | undefined) {
  const s = statusDe(e);
  return {
    sq: p.sq,
    nome: p.nome,
    cargo: ROTULO_CARGO[p.cargo] ?? p.cargo,
    uf: p.uf,
    ...(p.mun ? { municipio: p.mun } : {}),
    partido: p.partido,
    numero: p.n,
    situacao: ROTULO_SITUACAO[p.sit] ?? p.sit,
    status_flavio: ROTULO_STATUS[s],
    posts_no_periodo: e?.posts ?? 0,
    posts_citando: e?.citou ?? 0,
    pedidos_de_voto: e?.pediuVoto ?? 0,
    ...(e?.citou
      ? {
          views_posts_citando: e.views,
          interacoes_posts_citando: e.interacoes,
          primeira_citacao: dataBR(e.primeiraCitacao),
          ultima_citacao: dataBR(e.ultimaCitacao),
        }
      : {}),
  };
}

export function formatarPost(p: Post, d: Dados, incluirAutor = true) {
  const autor = d.pessoasPorSq.get(p.sq);
  return {
    id: p.id,
    data: dataBR(p.t),
    ...(incluirAutor && autor
      ? { autor: autor.nome, cargo: ROTULO_CARGO[autor.cargo], uf: autor.uf, partido: autor.partido, sq: p.sq }
      : {}),
    rede: ROTULO_REDE[p.rede] ?? p.rede,
    nivel: ROTULO_NIVEL[p.flavio],
    ...(p.conta ? { conta: p.conta } : {}),
    ...(p.url ? { url: p.url } : {}),
    ...(p.formato ? { formato: p.formato } : {}),
    ...(p.texto ? { texto: p.texto } : {}),
    ...(p.fala ? { citado_na_fala_do_video: true } : {}),
    ...(p.trecho ? { trecho_transcrito: p.trecho } : {}),
    ...(p.url
      ? {
          views: p.views ?? null,
          likes: p.likes ?? null,
          comentarios: p.comentarios ?? null,
          compartilhamentos: p.compartilhamentos ?? null,
        }
      : {}),
  };
}

export const pct = (parte: number, total: number) => (total ? Math.round((parte / total) * 1000) / 10 : 0);
