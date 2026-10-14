#!/usr/bin/env node
// Servidor MCP (stdio) não oficial para os dados públicos do Flaviômetro.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

import {
  ROTULO_CARGO,
  ROTULO_NIVEL,
  ROTULO_REDE,
  ROTULO_SITUACAO,
  ROTULO_STATUS,
  dataBR,
  estatisticasPorPessoa,
  filtrarPessoas,
  formatarPost,
  interacoes,
  normalizar,
  parseData,
  pct,
  resumoPessoa,
  statusDe,
  type FiltroPessoa,
  type StatusFlavio,
} from "./analise.js";
import { dadosCampanha, formatarCampanha } from "./tse.js";
import { BASE_URL, DESCRICAO_PROXY, obterDados, type Dados, type Pessoa, type Post } from "./fonte.js";

const server = new McpServer(
  { name: "flaviometro-mcp", version: "0.1.0" },
  {
    instructions:
      "Servidor NÃO OFICIAL que lê os dados públicos do site flaviometro.com, que monitora quais políticos " +
      "do PL e aliados citam o Flávio Bolsonaro ou pedem voto para ele nas redes sociais. " +
      "Os números refletem o que o site captou e classificou automaticamente; podem ter atrasos e erros. " +
      "Ao apresentar resultados, cite o Flaviômetro como fonte e lembre que este cliente não é oficial.",
  },
);

// ---------- esquemas compartilhados ----------

const cargo = z.enum(["gov", "sen", "fed", "est", "pref"]).describe(
  "gov = governador(a), sen = senador(a), fed = deputado(a) federal, est = deputado(a) estadual, pref = prefeito(a)",
);
const situacao = z.enum(["eleito", "2t", "mandato"]).describe(
  "eleito = eleito(a) em 2026, 2t = disputa o 2º turno, mandato = em mandato (não disputou em 2026)",
);
const rede = z.enum(["ig", "fb", "x", "th", "yt", "tt", "kw", "tg"]).describe(
  "ig = Instagram, fb = Facebook, x = X/Twitter, th = Threads, yt = YouTube, tt = TikTok, kw = Kwai, tg = Telegram",
);
const status = z.enum(["pediu_voto", "citou", "nao_citou", "sem_posts"]).describe(
  "pediu_voto = pediu voto ao menos uma vez; citou = citou mas nunca pediu voto; " +
    "nao_citou = postou no período sem citar; sem_posts = nenhum post captado",
);

const filtrosPessoa = {
  nome: z.string().optional().describe("Parte do nome (sem diferenciar acentos/maiúsculas) ou o código sq exato"),
  uf: z.string().length(2).optional().describe("Sigla do estado, ex.: SP"),
  cargo: cargo.optional(),
  partido: z.string().optional().describe("Sigla do partido, ex.: PL, NOVO, UNIÃO"),
  situacao: situacao.optional(),
  municipio: z.string().optional().describe("Município (só se aplica a prefeitos)"),
};

const janela = {
  desde: z.string().optional().describe("Início do período (AAAA-MM-DD ou ISO 8601, horário de Brasília)"),
  ate: z.string().optional().describe("Fim do período (AAAA-MM-DD ou ISO 8601, horário de Brasília)"),
};

// ---------- utilidades ----------

const resposta = (dados: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(dados, null, 2) }],
});

const erro = (mensagem: string) => ({
  content: [{ type: "text" as const, text: mensagem }],
  isError: true,
});

function periodo(d: Dados, desde?: string, ate?: string) {
  return { desde: parseData(desde), ate: parseData(ate, true) };
}

function metadados(d: Dados) {
  return {
    fonte: `${BASE_URL} (não oficial)`,
    proxy: DESCRICAO_PROXY,
    feed_gerado_em: dataBR(d.feed.gerado),
    feed_cobre_desde: dataBR(d.feed.desde),
    cadastro_atualizado_em: d.cadastroGerado,
  };
}

function acharPessoa(d: Dados, consulta: string): Pessoa[] {
  const exata = d.pessoasPorSq.get(consulta);
  if (exata) return [exata];
  const q = normalizar(consulta);
  const iguais = d.pessoas.filter((p) => normalizar(p.nome) === q);
  return iguais.length ? iguais : d.pessoas.filter((p) => normalizar(p.nome).includes(q));
}

function ambiguidade(candidatos: Pessoa[]) {
  return erro(
    `Encontrei ${candidatos.length} políticos com esse nome. Refine a busca ou use o código sq:\n` +
      candidatos
        .slice(0, 20)
        .map((p) => `- ${p.nome} (${ROTULO_CARGO[p.cargo]}, ${p.uf}, ${p.partido}) — sq ${p.sq}`)
        .join("\n"),
  );
}

// ---------- ferramentas ----------

server.registerTool(
  "resumo_geral",
  {
    title: "Resumo geral",
    description:
      "Panorama do Flaviômetro: quantos políticos monitorados citaram o Flávio, quantos pediram voto, " +
      "quantos ficaram em silêncio, totais de posts e quebra por cargo. Use como ponto de partida.",
    inputSchema: { ...janela },
  },
  async ({ desde, ate }) => {
    const d = await obterDados();
    const j = periodo(d, desde, ate);
    const est = estatisticasPorPessoa(d.feed.posts, j.desde, j.ate);

    const contar = (pessoas: Pessoa[]) => {
      const c: Record<StatusFlavio, number> = { pediu_voto: 0, citou: 0, nao_citou: 0, sem_posts: 0 };
      for (const p of pessoas) c[statusDe(est.get(p.sq))]++;
      const total = pessoas.length;
      return {
        politicos: total,
        pediram_voto: c.pediu_voto,
        citaram_sem_pedir_voto: c.citou,
        postaram_sem_citar: c.nao_citou,
        sem_posts_captados: c.sem_posts,
        pct_que_citou: pct(c.pediu_voto + c.citou, total),
        pct_que_pediu_voto: pct(c.pediu_voto, total),
      };
    };

    const postsJanela = d.feed.posts.filter((p) => (!j.desde || p.t >= j.desde) && (!j.ate || p.t <= j.ate));
    const citando = postsJanela.filter((p) => p.flavio >= 1);

    return resposta({
      ...metadados(d),
      periodo_consultado: { desde: dataBR(j.desde ?? d.feed.desde), ate: dataBR(j.ate ?? d.feed.gerado) },
      geral: contar(d.pessoas),
      por_cargo: Object.fromEntries(
        (Object.keys(ROTULO_CARGO) as (keyof typeof ROTULO_CARGO)[]).map((c) => [
          ROTULO_CARGO[c],
          contar(d.pessoas.filter((p) => p.cargo === c)),
        ]),
      ),
      posts: {
        total_captados: postsJanela.length,
        citando_o_flavio: citando.length,
        pedindo_voto: citando.filter((p) => p.flavio === 2).length,
        citacoes_na_fala_de_videos: citando.filter((p) => p.fala).length,
        views_dos_posts_citando: citando.reduce((s, p) => s + (p.views ?? 0), 0),
        interacoes_dos_posts_citando: citando.reduce((s, p) => s + interacoes(p), 0),
      },
    });
  },
);

server.registerTool(
  "buscar_politicos",
  {
    title: "Buscar políticos",
    description:
      "Lista políticos monitorados com filtros (nome, UF, cargo, partido, situação, município) e pelo " +
      "comportamento em relação ao Flávio (pediu voto, citou, não citou, sem posts). " +
      "Útil para perguntas como 'quais deputados federais do PL de SP não citaram o Flávio?'.",
    inputSchema: {
      ...filtrosPessoa,
      status: status.optional(),
      ...janela,
      ordenar_por: z
        .enum(["nome", "votos", "posts_citando", "pedidos_de_voto", "posts_no_periodo"])
        .default("nome")
        .describe("Critério de ordenação (numéricos em ordem decrescente)"),
      limite: z.number().int().min(1).max(500).default(50),
    },
  },
  async ({ status: st, desde, ate, ordenar_por, limite, ...f }) => {
    const d = await obterDados();
    const j = periodo(d, desde, ate);
    const est = estatisticasPorPessoa(d.feed.posts, j.desde, j.ate);

    let lista = filtrarPessoas(d.pessoas, f as FiltroPessoa);
    if (st) lista = lista.filter((p) => statusDe(est.get(p.sq)) === st);

    const chave: Record<typeof ordenar_por, (p: Pessoa) => number> = {
      nome: () => 0,
      votos: (p) => p.votos,
      posts_citando: (p) => est.get(p.sq)?.citou ?? 0,
      pedidos_de_voto: (p) => est.get(p.sq)?.pediuVoto ?? 0,
      posts_no_periodo: (p) => est.get(p.sq)?.posts ?? 0,
    };
    lista.sort((a, b) =>
      ordenar_por === "nome" ? a.nome.localeCompare(b.nome, "pt-BR") : chave[ordenar_por](b) - chave[ordenar_por](a),
    );

    return resposta({
      total_encontrado: lista.length,
      exibindo: Math.min(limite, lista.length),
      politicos: lista.slice(0, limite).map((p) => resumoPessoa(p, est.get(p.sq))),
    });
  },
);

server.registerTool(
  "detalhes_politico",
  {
    title: "Detalhes de um político",
    description:
      "Ficha completa de um político: cargo, partido, votos, redes monitoradas, janela de cobertura, " +
      "estatísticas por rede e os posts mais recentes em que citou o Flávio.",
    inputSchema: {
      politico: z.string().describe("Nome (ou parte dele) ou código sq"),
      posts: z.number().int().min(0).max(100).default(10).describe("Quantos posts recentes citando o Flávio incluir"),
      incluir_posts_sem_citacao: z.boolean().default(false).describe("Inclui também posts que não citam o Flávio"),
    },
  },
  async ({ politico, posts: qtd, incluir_posts_sem_citacao }) => {
    const d = await obterDados();
    const achados = acharPessoa(d, politico);
    if (achados.length === 0) return erro(`Nenhum político encontrado para "${politico}".`);
    if (achados.length > 1) return ambiguidade(achados);
    const p = achados[0];

    const seus = d.feed.posts.filter((x) => x.sq === p.sq);
    const est = estatisticasPorPessoa(seus).get(p.sq);
    const porRede: Record<string, { posts: number; citando: number; pedindo_voto: number }> = {};
    for (const x of seus) {
      const r = (porRede[ROTULO_REDE[x.rede] ?? x.rede] ??= { posts: 0, citando: 0, pedindo_voto: 0 });
      r.posts++;
      if (x.flavio >= 1) r.citando++;
      if (x.flavio === 2) r.pedindo_voto++;
    }
    const cob = d.feed.cobertura[p.sq];

    return resposta({
      ...resumoPessoa(p, est),
      genero: p.g === "F" ? "Feminino" : "Masculino",
      votos: p.votos,
      redes_monitoradas: p.redes.map(([r, usuario, url, marca]) => ({
        rede: ROTULO_REDE[r as keyof typeof ROTULO_REDE] ?? r,
        usuario,
        url,
        ...(marca ? { observacao: marca } : {}),
      })),
      ...(cob ? { cobertura_informada_pelo_feed: { inicio: dataBR(cob[0]), fim: dataBR(cob[1]) } } : {}),
      por_rede: porRede,
      posts: seus
        .filter((x) => incluir_posts_sem_citacao || x.flavio >= 1)
        .slice(0, qtd)
        .map((x) => formatarPost(x, d, false)),
    });
  },
);

server.registerTool(
  "listar_posts",
  {
    title: "Listar posts",
    description:
      "Lista posts captados pelo Flaviômetro com filtros por político, rede, nível de citação, período e texto. " +
      "Por padrão traz só posts que citam o Flávio, do mais recente para o mais antigo.",
    inputSchema: {
      ...filtrosPessoa,
      rede: rede.optional(),
      nivel_minimo: z
        .number()
        .int()
        .min(0)
        .max(2)
        .default(1)
        .describe("0 = todos os posts, 1 = citou o Flávio, 2 = só pedidos de voto"),
      somente_fala_em_video: z.boolean().default(false).describe("Só posts em que a citação foi detectada na fala do vídeo"),
      texto: z.string().optional().describe("Busca no texto da legenda e no trecho transcrito"),
      ...janela,
      ordenar_por: z.enum(["recentes", "views", "likes", "interacoes"]).default("recentes"),
      limite: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ rede: r, nivel_minimo, somente_fala_em_video, texto, desde, ate, ordenar_por, limite, ...f }) => {
    const d = await obterDados();
    const j = periodo(d, desde, ate);
    const temFiltroPessoa = Object.values(f).some(Boolean);
    const sqs = temFiltroPessoa ? new Set(filtrarPessoas(d.pessoas, f as FiltroPessoa).map((p) => p.sq)) : null;
    const q = texto && normalizar(texto);

    let lista = d.feed.posts.filter(
      (p) =>
        p.flavio >= nivel_minimo &&
        (!sqs || sqs.has(p.sq)) &&
        (!r || p.rede === r) &&
        (!somente_fala_em_video || p.fala) &&
        (!j.desde || p.t >= j.desde) &&
        (!j.ate || p.t <= j.ate) &&
        (!q || normalizar(`${p.texto ?? ""} ${p.trecho ?? ""}`).includes(q)),
    );

    const chave: Record<Exclude<typeof ordenar_por, "recentes">, (p: Post) => number> = {
      views: (p) => p.views ?? -1,
      likes: (p) => p.likes ?? -1,
      interacoes,
    };
    if (ordenar_por !== "recentes") lista = [...lista].sort((a, b) => chave[ordenar_por](b) - chave[ordenar_por](a));

    return resposta({
      total_encontrado: lista.length,
      exibindo: Math.min(limite, lista.length),
      observacao:
        nivel_minimo === 0
          ? "Posts que não citam o Flávio vêm sem texto, link e métricas: o feed só registra que existiram."
          : undefined,
      posts: lista.slice(0, limite).map((p) => formatarPost(p, d)),
    });
  },
);

server.registerTool(
  "ranking",
  {
    title: "Ranking de políticos",
    description:
      "Ranking dos políticos que mais citaram o Flávio segundo uma métrica (posts citando, pedidos de voto, " +
      "views ou interações dos posts citando). Aceita os mesmos filtros de buscar_politicos.",
    inputSchema: {
      metrica: z.enum(["posts_citando", "pedidos_de_voto", "views", "interacoes"]).default("posts_citando"),
      ...filtrosPessoa,
      ...janela,
      limite: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ metrica, desde, ate, limite, ...f }) => {
    const d = await obterDados();
    const j = periodo(d, desde, ate);
    const est = estatisticasPorPessoa(d.feed.posts, j.desde, j.ate);
    const valor = (sq: string) => {
      const e = est.get(sq);
      if (!e) return 0;
      return { posts_citando: e.citou, pedidos_de_voto: e.pediuVoto, views: e.views, interacoes: e.interacoes }[metrica];
    };
    const lista = filtrarPessoas(d.pessoas, f as FiltroPessoa)
      .filter((p) => valor(p.sq) > 0)
      .sort((a, b) => valor(b.sq) - valor(a.sq))
      .slice(0, limite);

    return resposta({
      metrica,
      ranking: lista.map((p, i) => ({ posicao: i + 1, valor: valor(p.sq), ...resumoPessoa(p, est.get(p.sq)) })),
    });
  },
);

server.registerTool(
  "estatisticas_agrupadas",
  {
    title: "Estatísticas agrupadas",
    description:
      "Agrega os números por estado, partido, cargo, rede social ou dia: quantos políticos citaram/pediram voto " +
      "e quantos posts citando o Flávio houve em cada grupo.",
    inputSchema: {
      agrupar_por: z.enum(["uf", "partido", "cargo", "situacao", "rede", "dia"]),
      ...filtrosPessoa,
      ...janela,
    },
  },
  async ({ agrupar_por, desde, ate, ...f }) => {
    const d = await obterDados();
    const j = periodo(d, desde, ate);
    const pessoas = filtrarPessoas(d.pessoas, f as FiltroPessoa);
    const sqs = new Set(pessoas.map((p) => p.sq));
    const posts = d.feed.posts.filter(
      (p) => sqs.has(p.sq) && (!j.desde || p.t >= j.desde) && (!j.ate || p.t <= j.ate),
    );

    type Grupo = { posts: number; citando: number; pedindo_voto: number; views: number; politicos?: number; politicos_que_citaram?: number; politicos_que_pediram_voto?: number };
    const grupos = new Map<string, Grupo>();
    const g = (k: string) => grupos.get(k) ?? grupos.set(k, { posts: 0, citando: 0, pedindo_voto: 0, views: 0 }).get(k)!;

    if (agrupar_por === "rede" || agrupar_por === "dia") {
      const fmtDia = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" });
      for (const p of posts) {
        const k = agrupar_por === "rede" ? (ROTULO_REDE[p.rede] ?? p.rede) : fmtDia.format(new Date(p.t));
        const x = g(k);
        x.posts++;
        if (p.flavio >= 1) (x.citando++, (x.views += p.views ?? 0));
        if (p.flavio === 2) x.pedindo_voto++;
      }
    } else {
      const est = estatisticasPorPessoa(posts);
      const rotulo = (p: Pessoa) =>
        agrupar_por === "cargo"
          ? ROTULO_CARGO[p.cargo]
          : agrupar_por === "situacao"
            ? ROTULO_SITUACAO[p.sit]
            : p[agrupar_por];
      for (const p of pessoas) {
        const x = g(rotulo(p));
        const e = est.get(p.sq);
        x.politicos = (x.politicos ?? 0) + 1;
        x.politicos_que_citaram = (x.politicos_que_citaram ?? 0) + (e?.citou ? 1 : 0);
        x.politicos_que_pediram_voto = (x.politicos_que_pediram_voto ?? 0) + (e?.pediuVoto ? 1 : 0);
        x.posts += e?.posts ?? 0;
        x.citando += e?.citou ?? 0;
        x.pedindo_voto += e?.pediuVoto ?? 0;
        x.views += e?.views ?? 0;
      }
    }

    const linhas = [...grupos.entries()].map(([grupo, x]) => ({
      grupo,
      ...x,
      ...(x.politicos ? { pct_politicos_que_citaram: pct(x.politicos_que_citaram ?? 0, x.politicos) } : {}),
    }));
    linhas.sort((a, b) => (agrupar_por === "dia" ? a.grupo.localeCompare(b.grupo) : b.citando - a.citando));

    return resposta({ agrupado_por: agrupar_por, grupos: linhas });
  },
);

server.registerTool(
  "contato_campanha",
  {
    title: "Contato da campanha (TSE + Receita)",
    description:
      "Busca o CNPJ de campanha de um candidato de 2026 nos dados abertos do TSE e consulta esse CNPJ no " +
      "OpenCNPJ (base da Receita Federal) para obter o e-mail, telefone e endereço registrados pela campanha. " +
      "Também traz coligação, resultado e o link da página do candidato no DivulgaCandContas. " +
      "Funciona para quem disputou 2026 (governadores, senadores e deputados); não cobre prefeitos " +
      "nem senadores em mandato. Consulta um político por vez.",
    inputSchema: {
      politico: z.string().describe("Nome (ou parte dele) ou código sq do candidato"),
    },
  },
  async ({ politico }) => {
    const d = await obterDados();
    const achados = acharPessoa(d, politico);
    if (achados.length > 1) return ambiguidade(achados);

    const sq = achados[0]?.sq ?? (/^\d{10,13}$/.test(politico.trim()) ? politico.trim() : null);
    if (!sq) return erro(`Nenhum político encontrado para "${politico}".`);
    if (achados[0]?.sit === "mandato")
      return erro(
        `${achados[0].nome} está em mandato e não disputou a eleição de 2026, então não tem CNPJ de campanha ` +
          "nos dados de 2026 do TSE.",
      );

    const r = await dadosCampanha(sq);
    if (!r) return erro(`O sq ${sq} não está na base de candidatos 2026 do TSE.`);
    return resposta(formatarCampanha(r));
  },
);

server.registerTool(
  "legenda",
  {
    title: "Legenda dos códigos",
    description: "Explica os códigos usados nos dados (cargos, situações, redes, níveis de citação) e a metodologia.",
    inputSchema: {},
  },
  async () =>
    resposta({
      cargos: ROTULO_CARGO,
      situacoes: ROTULO_SITUACAO,
      redes: ROTULO_REDE,
      niveis_de_citacao: Object.fromEntries(ROTULO_NIVEL.map((r, i) => [i, r])),
      status_flavio: ROTULO_STATUS,
      metodologia: {
        "Citou o Flávio": "Cita o Flávio pelo nome, @, hashtag ou o 22 como voto (segundo o site).",
        "Pediu voto": "Pede voto no Flávio, como “vote 22” ou “dia 25 é Flávio” (segundo o site).",
        "Fala em vídeo": "O que é dito no vídeo também conta; nesses casos vem o trecho transcrito.",
        sq: "Código sequencial do candidato no TSE, usado como identificador.",
        cobertura:
          "O feed traz um par [início, fim] por político. O site não documenta o significado exato; trate como indicativo.",
      },
      aviso: "Classificação feita pelo Flaviômetro, não por este servidor. Este cliente não é oficial.",
    }),
);

server.registerTool(
  "atualizar_dados",
  {
    title: "Atualizar dados",
    description: "Força um novo download do feed do Flaviômetro, ignorando o cache local.",
    inputSchema: {},
  },
  async () => {
    const d = await obterDados(true);
    return resposta({ ...metadados(d), politicos: d.pessoas.length, posts: d.feed.posts.length });
  },
);

const transporte = new StdioServerTransport();
await server.connect(transporte);
console.error(`flaviometro-mcp rodando via stdio (fonte: ${BASE_URL}, proxy: ${DESCRICAO_PROXY})`);
