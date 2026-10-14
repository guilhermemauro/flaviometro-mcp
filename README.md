# flaviometro-mcp

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) local para consultar, direto do seu assistente de IA, os dados públicos do **[Flaviômetro](https://flaviometro.com)**, o site que acompanha ao vivo quais deputados, senadores, governadores e prefeitos do PL e aliados falam do Flávio Bolsonaro nas redes sociais.

Com ele você pergunta em português ao Claude (ou a outro cliente MCP) coisas como *"quais senadores eleitos ainda não citaram o Flávio?"* e recebe a resposta calculada em cima dos dados mais recentes do site.

> [!WARNING]
> **Projeto não oficial.** Este repositório não tem nenhuma ligação com o Flaviômetro, seus autores, o PL, o Flávio Bolsonaro ou qualquer campanha. Ele não é mantido, endossado nem revisado pelo site.
>
> Este projeto também não tem ligação com o TSE nem com o OpenCNPJ, usados pela ferramenta `contato_campanha`.
>
> O Flaviômetro **não oferece uma API pública**. Este servidor lê o mesmo arquivo JSON que o navegador baixa ao abrir o site. Se o site mudar o formato, o servidor pode parar de funcionar sem aviso. Os números e classificações são do Flaviômetro; este projeto só os organiza.

---

## Sumário

- [O que dá para fazer](#o-que-dá-para-fazer)
- [Ferramentas disponíveis](#ferramentas-disponíveis)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Configurando no seu cliente MCP](#configurando-no-seu-cliente-mcp)
- [Exemplos de perguntas](#exemplos-de-perguntas)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Usando um proxy](#usando-um-proxy)
- [De onde vêm os dados](#de-onde-vêm-os-dados)
- [Contato da campanha (TSE + OpenCNPJ)](#contato-da-campanha-tse--opencnpj)
- [Glossário dos códigos](#glossário-dos-códigos)
- [Limitações conhecidas](#limitações-conhecidas)
- [Desenvolvimento](#desenvolvimento)
- [Uso responsável](#uso-responsável)
- [Licença](#licença)

---

## O que dá para fazer

- Ver o **panorama geral**: quantos políticos monitorados pediram voto, quantos só citaram, quantos postaram sem citar e quantos não postaram nada.
- **Filtrar políticos** por nome, estado, cargo, partido, situação eleitoral e município.
- Descobrir **quem ficou em silêncio** (postou no período, mas não falou do Flávio).
- Abrir a **ficha de um político**: redes monitoradas, números por rede e os posts mais recentes em que citou o Flávio.
- **Listar e buscar posts** por rede, período, texto da legenda ou trecho falado em vídeo.
- Montar **rankings** por posts, pedidos de voto, visualizações ou interações.
- **Agregar** os números por estado, partido, cargo, rede social ou dia.
- Obter o **contato da campanha** de um candidato de 2026: o CNPJ de campanha (TSE) e o e-mail, telefone e endereço registrados na Receita Federal (via OpenCNPJ).

## Ferramentas disponíveis

| Ferramenta | Para que serve | Principais parâmetros |
| --- | --- | --- |
| `resumo_geral` | Panorama do período, geral e por cargo | `desde`, `ate` |
| `buscar_politicos` | Lista políticos com filtros e status em relação ao Flávio | `nome`, `uf`, `cargo`, `partido`, `situacao`, `municipio`, `status`, `ordenar_por`, `limite` |
| `detalhes_politico` | Ficha completa de um político e seus posts recentes | `politico` (nome ou código `sq`), `posts`, `incluir_posts_sem_citacao` |
| `listar_posts` | Posts captados, com filtros e ordenação | filtros de político, `rede`, `nivel_minimo`, `somente_fala_em_video`, `texto`, `desde`, `ate`, `ordenar_por`, `limite` |
| `ranking` | Quem mais citou o Flávio segundo uma métrica | `metrica`, filtros de político, `desde`, `ate`, `limite` |
| `estatisticas_agrupadas` | Números agregados por grupo | `agrupar_por` (`uf`, `partido`, `cargo`, `situacao`, `rede`, `dia`) |
| `contato_campanha` | CNPJ de campanha (TSE) e e-mail/endereço registrados na Receita (OpenCNPJ) | `politico` (nome ou código `sq`) |
| `legenda` | Explica os códigos e a metodologia | — |
| `atualizar_dados` | Força novo download, ignorando o cache | — |

Datas aceitam `AAAA-MM-DD` (interpretadas no horário de Brasília) ou ISO 8601 completo.

## Requisitos

- [Node.js](https://nodejs.org) **20.18.1 ou mais recente** (testado no 22)
- Um cliente compatível com MCP: Claude Desktop, Claude Code, OpenCode, Cursor, VS Code, etc.

## Instalação

```bash
git clone <url-deste-repositorio> flaviometro-mcp
cd flaviometro-mcp
npm install
npm run build
```

Isso gera o servidor em `dist/index.js`. Anote o **caminho absoluto** desse arquivo, ele vai na configuração do cliente. Para descobrir:

```bash
echo "$(pwd)/dist/index.js"
```

## Configurando no seu cliente MCP

O servidor usa transporte **stdio**: o cliente inicia o processo e conversa com ele pela entrada e saída padrão. Não há porta nem servidor web.

### Claude Code

```bash
claude mcp add flaviometro -- node /caminho/absoluto/flaviometro-mcp/dist/index.js
```

Confira com `claude mcp list`, ou digite `/mcp` dentro de uma sessão.

Em todos os exemplos abaixo, troque `/caminho/absoluto/flaviometro-mcp/dist/index.js` pelo caminho que você anotou na [instalação](#instalação). Caminhos relativos e `~` não funcionam.

### Claude Desktop

1. Abra o Claude Desktop e vá em **Configurações → Desenvolvedor → Editar configuração**. Isso abre (ou cria) o arquivo:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Adicione o servidor dentro de `mcpServers`. Se o arquivo já tiver outros servidores, inclua só a entrada `flaviometro`:

   ```json
   {
     "mcpServers": {
       "flaviometro": {
         "command": "node",
         "args": ["/caminho/absoluto/flaviometro-mcp/dist/index.js"]
       }
     }
   }
   ```

   No Windows, escape as barras: `"C:\\Users\\voce\\flaviometro-mcp\\dist\\index.js"`.
3. **Feche o Claude Desktop por completo** (no macOS, `Cmd+Q`; só fechar a janela não basta) e abra de novo.
4. Na caixa de mensagem, clique no ícone de ferramentas/conectores: o `flaviometro` deve aparecer com as 9 ferramentas. Na primeira vez que uma for usada, o Claude pede sua permissão.

> **Não apareceu?** Em **Configurações → Desenvolvedor** o servidor aparece com o status e um botão para ver os logs. O erro mais comum é `node` não ser encontrado: nesse caso, use o caminho completo do Node em `command` (descubra com `which node` no macOS/Linux ou `where node` no Windows).

### OpenCode

O [OpenCode](https://opencode.ai) lê os servidores MCP da chave `mcp` do arquivo de configuração. Escolha onde colocar:

- **Global** (vale para todos os projetos): `~/.config/opencode/opencode.json`
- **Só em um projeto:** `opencode.json` na raiz do projeto

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "flaviometro": {
      "type": "local",
      "command": ["node", "/caminho/absoluto/flaviometro-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

Repare que, diferente dos outros clientes, no OpenCode o `command` é uma **lista** com o executável e os argumentos juntos. Variáveis de ambiente vão na chave `environment`:

```json
"flaviometro": {
  "type": "local",
  "command": ["node", "/caminho/absoluto/flaviometro-mcp/dist/index.js"],
  "enabled": true,
  "environment": { "FLAVIOMETRO_CACHE_TTL_SEGUNDOS": "600" }
}
```

Se o arquivo já existir, junte a chave `mcp` com o que já estiver lá. Depois, reinicie o OpenCode e confira com:

```bash
opencode mcp list
```

> O primeiro carregamento baixa alguns megabytes do site. Se o OpenCode reclamar de tempo esgotado ao listar as ferramentas, adicione `"timeout": 20000` na entrada do servidor.

### Cursor

O Cursor lê os servidores de um arquivo `mcp.json`:

- **Global** (vale para todos os projetos): `~/.cursor/mcp.json`
- **Só em um projeto:** `.cursor/mcp.json` na raiz do projeto

```json
{
  "mcpServers": {
    "flaviometro": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/absoluto/flaviometro-mcp/dist/index.js"]
    }
  }
}
```

Variáveis de ambiente vão na chave `env`, como no Claude Desktop.

Depois de salvar:

1. Abra as configurações do Cursor na área de MCP e confira se o `flaviometro` aparece com a chave ligada. Servidores desligados não carregam nem aparecem no chat.
2. No chat em **modo Agent**, faça uma pergunta como "me dá um resumo do Flaviômetro". O Cursor pede confirmação antes de rodar cada ferramenta.

> **Deu erro?** Abra o painel Output (`Cmd+Shift+U` no macOS, `Ctrl+Shift+U` no Windows/Linux) e escolha **MCP Logs** na lista. Ali aparecem a inicialização do servidor, as chamadas e os erros.

### Outros clientes

Qualquer cliente que aceite servidores MCP via stdio funciona com o mesmo par `command` + `args`. No VS Code, por exemplo, o arquivo é `.vscode/mcp.json` e a chave é `servers` no lugar de `mcpServers`.

### Testando sem cliente

O [MCP Inspector](https://github.com/modelcontextprotocol/inspector) abre uma interface web para chamar as ferramentas na mão:

```bash
npm run inspector
```

## Exemplos de perguntas

Depois de configurado, é só conversar normalmente:

- "Me dá um resumo do Flaviômetro de hoje."
- "Quais senadores eleitos em 2026 postaram nos últimos dias mas não citaram o Flávio?"
- "Ranking dos 10 deputados federais de SP que mais pediram voto para o Flávio."
- "Como está o deputado Fulano de Tal? Mostra os últimos posts dele citando o Flávio."
- "Compara os partidos: qual tem a maior proporção de políticos que já citaram o Flávio?"
- "Quais vídeos mencionam o Flávio só na fala, e não na legenda? Traz os trechos."
- "Quantos posts pedindo voto saíram por dia desde 08/10?"
- "Quais prefeitos do Rio de Janeiro já pediram voto?"
- "Qual é o e-mail da campanha do candidato Fulano de Tal?"

## Variáveis de ambiente

Todas são opcionais.

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `FLAVIOMETRO_CACHE_TTL_SEGUNDOS` | `300` | Por quanto tempo os dados ficam em cache na memória antes de novo download |
| `FLAVIOMETRO_BASE_URL` | `https://flaviometro.com` | Endereço base do site (útil para testes ou espelhos) |
| `FLAVIOMETRO_VERSAO` | — | Valor de `?v=` usado no feed caso não seja possível lê-lo da página |
| `FLAVIOMETRO_TSE_CACHE_HORAS` | `6` | Por quanto tempo as bases do TSE e as consultas ao OpenCNPJ ficam em cache |
| `FLAVIOMETRO_OPENCNPJ_URL` | `https://api.opencnpj.org` | Endereço da API do OpenCNPJ |
| `FLAVIOMETRO_PROXY` | — | Proxy usado para acessar o site (veja [Usando um proxy](#usando-um-proxy)) |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | — | Variáveis de proxy padrão do sistema, usadas se `FLAVIOMETRO_PROXY` não estiver definida |

Exemplo no Claude Desktop:

```json
{
  "mcpServers": {
    "flaviometro": {
      "command": "node",
      "args": ["/caminho/absoluto/flaviometro-mcp/dist/index.js"],
      "env": { "FLAVIOMETRO_CACHE_TTL_SEGUNDOS": "600" }
    }
  }
}
```

## Usando um proxy

O proxy vale para todas as conexões do servidor: Flaviômetro, TSE e OpenCNPJ.

Se você está atrás de um proxy corporativo, quer sair por outro IP ou passar o tráfego por um túnel SSH, o servidor pode acessar o Flaviômetro por um proxy **HTTP**, **HTTPS** ou **SOCKS5**.

### Ordem de prioridade

1. **`FLAVIOMETRO_PROXY`**: se estiver definida, vale ela e só ela.
2. **`HTTPS_PROXY` / `HTTP_PROXY`** (maiúsculas ou minúsculas): as variáveis padrão do sistema, respeitando `NO_PROXY`.
3. Nenhuma das duas: conexão direta.

Para ignorar o proxy do sistema só neste servidor, use `FLAVIOMETRO_PROXY=desligado`.

### Formatos aceitos

| Tipo | Exemplo |
| --- | --- |
| HTTP | `http://proxy.empresa.com.br:3128` |
| HTTP com usuário e senha | `http://usuario:senha@proxy.empresa.com.br:3128` |
| HTTPS (conexão TLS até o proxy) | `https://proxy.empresa.com.br:443` |
| SOCKS5 | `socks5://127.0.0.1:1080` |
| SOCKS5 com usuário e senha | `socks5://usuario:senha@127.0.0.1:1080` |
| Desativar | `desligado` |

Caracteres especiais no usuário ou na senha (`@`, `:`, `/`, `#`...) precisam estar codificados em URL. Por exemplo, `p@ss` vira `p%40ss`.

### Exemplos de configuração

**Claude Desktop / Cursor** (chave `env`):

```json
{
  "mcpServers": {
    "flaviometro": {
      "command": "node",
      "args": ["/caminho/absoluto/flaviometro-mcp/dist/index.js"],
      "env": { "FLAVIOMETRO_PROXY": "http://usuario:senha@proxy.empresa.com.br:3128" }
    }
  }
}
```

**OpenCode** (chave `environment`):

```json
"flaviometro": {
  "type": "local",
  "command": ["node", "/caminho/absoluto/flaviometro-mcp/dist/index.js"],
  "enabled": true,
  "environment": { "FLAVIOMETRO_PROXY": "socks5://127.0.0.1:1080" }
}
```

**Claude Code:**

```bash
claude mcp add flaviometro -e FLAVIOMETRO_PROXY=http://proxy.empresa.com.br:3128 \
  -- node /caminho/absoluto/flaviometro-mcp/dist/index.js
```

**Túnel SSH como proxy SOCKS5:** abra o túnel num terminal e aponte o servidor para ele.

```bash
ssh -D 1080 -N usuario@seu-servidor.com
# e use FLAVIOMETRO_PROXY=socks5://127.0.0.1:1080
```

### Conferindo se o proxy está em uso

- A ferramenta `atualizar_dados` mostra no campo `proxy` qual configuração está ativa. Usuário e senha aparecem mascarados (`http://***@host:3128`).
- A mesma informação sai no log de inicialização do servidor (stderr), visível nos logs do seu cliente MCP.
- Se o proxy estiver fora do ar ou mal configurado, as ferramentas respondem com o erro detalhado (por exemplo, `Não consegui acessar https://flaviometro.com/ via proxy HTTP http://127.0.0.1:3128: connect ECONNREFUSED`) em vez de travar.

> O suporte a SOCKS5 vem do [undici](https://github.com/nodejs/undici) e ainda é marcado como experimental por lá. Por isso aparece um `ExperimentalWarning` no log. É só um aviso e não afeta o funcionamento. Proxies com autenticação NTLM/Kerberos não são suportados diretamente; nesses casos, use um intermediário local como o [Px](https://github.com/genotrance/px) ou o [CNTLM](https://cntlm.sourceforge.net).

## De onde vêm os dados

O servidor faz duas requisições, as mesmas que o navegador faz ao abrir o site:

1. **`https://flaviometro.com/`**: a página inicial traz embutido o cadastro dos políticos monitorados (`window.ELEITOS`: nome, cargo, UF, partido, número, votos, redes) e a versão atual do site (`window.VERSAO`).
2. **`https://flaviometro.com/dados/feed.json?v=<versão>`**: um JSON de alguns megabytes com **todos os posts monitorados** no período, já classificados pelo site.

O cadastro é lido como dado: o servidor recorta o objeto do HTML e o converte para JSON, **sem executar nenhum JavaScript da página**.

Os dados ficam em memória pelo tempo do cache (5 minutos por padrão). Chamadas seguidas não geram novos downloads. Se um download falhar e já houver dados em cache, o servidor responde com o cache anterior.

```
┌──────────────┐  stdio  ┌──────────────────┐  HTTPS  ┌──────────────────────┐
│ Cliente MCP  │ ──────▶ │  flaviometro-mcp │ ──────▶ │ flaviometro.com      │
│ (Claude etc.)│ ◀────── │  cache + análise │ ◀────── │  /  e  /dados/feed   │
└──────────────┘         └──────────────────┘         └──────────────────────┘
```

## Contato da campanha (TSE + OpenCNPJ)

A ferramenta `contato_campanha` cruza três fontes públicas para chegar ao contato oficial da campanha de um candidato:

```
Flaviômetro            TSE (dados abertos)                    OpenCNPJ (Receita Federal)
sq do candidato ──▶ cadastro de candidatos 2026 ──▶ CNPJ ──▶ e-mail, telefone, endereço
                    + CNPJs de campanha 2026
```

1. **Cadastro de candidatos 2026** (`consulta_cand_2026.zip`, no [Portal de Dados Abertos do TSE](https://dadosabertos.tse.jus.br/dataset/candidatos-2026)): pelo `sq`, o servidor encontra o nome completo, o cargo, a coligação e o resultado.
2. **CNPJs de campanha 2026** (`CNPJ_campanha_2026.zip`, no [dataset de prestação de contas](https://dadosabertos.tse.jus.br/dataset/prestacao-de-contas-eleitorais-2026)): todo candidato recebe um CNPJ de campanha com a razão social `ELEICAO 2026 <NOME COMPLETO> <CARGO>`. Como esse arquivo não traz o `sq`, o vínculo é feito pelo nome completo + cargo.
3. **[OpenCNPJ](https://opencnpj.org)**: com o CNPJ, a API pública e gratuita do OpenCNPJ devolve o cadastro na Receita Federal, com o e-mail que a campanha informou.

Exemplo de resposta (resumida, com dados fictícios):

```json
{
  "candidato": {
    "nome_completo": "FULANO DE TAL DA SILVA",
    "cargo": "DEPUTADO FEDERAL",
    "uf": "SP",
    "resultado": "ELEITO",
    "link_divulgacandcontas": "https://divulgacandcontas.tse.jus.br/divulga/#/candidato/SUDESTE/SP/20322002026/250000000000/2026/SP"
  },
  "campanha": {
    "cnpj": "00.000.000/0001-00",
    "vinculo": "exata",
    "situacao_cadastral": "Ativa",
    "email": "contato@exemplo.com.br",
    "endereco": "RUA EXEMPLO, 100, CENTRO, SAO PAULO/SP, CEP 01000-000"
  }
}
```

**Como o vínculo é feito.** O campo `vinculo` diz quão confiável é o casamento entre candidato e CNPJ:

- `exata`: nome completo e cargo idênticos nos dois arquivos do TSE (é o caso de 988 dos 1.000 candidatos de 2026 monitorados pelo Flaviômetro).
- `aproximada (nome parecido, mesma UF)`: os dois arquivos do TSE grafam o nome de jeitos diferentes ("THYAGO" e "TYAGO", "SILVA COSTA" e "SILVA DA COSTA"). O servidor procura nomes parecidos no mesmo cargo e só aceita se a UF do CNPJ na Receita bater com a do candidato. A resposta mostra a razão social encontrada para você conferir.

**O que não é coberto:**

- **Prefeitos e senadores em mandato**: não disputaram 2026, então não têm CNPJ de campanha nas bases de 2026.
- **Dados pessoais**: o cadastro do TSE também traz CPF, título de eleitor e data de nascimento. O servidor **descarta esses campos na leitura**; eles nunca chegam ao modelo.
- **Página do DivulgaCandContas**: o link é montado para você abrir no navegador, mas o servidor não lê essa página. O TSE bloqueia acesso automatizado a ela (HTTP 403), por isso o servidor usa os arquivos de dados abertos. O código de eleição do link (`20322002026`) é o do 1º turno; para candidatos do 2º turno a página pode ser outra.

> [!NOTE]
> O e-mail e o telefone são os que a campanha **informou à Receita Federal** ao registrar o CNPJ. Muitas vezes são do contador, do escritório de advocacia ou da equipe, não do candidato. Telefones vêm vazios com frequência.

Na primeira chamada, o servidor baixa cerca de 6 MB do TSE, o que leva alguns segundos. Depois disso, as bases ficam em cache por 6 horas (configurável).

## Glossário dos códigos

**Nível de citação de cada post** (campo `flavio` no feed):

| Valor | Significado |
| --- | --- |
| `0` | Não citou o Flávio |
| `1` | Citou o Flávio pelo nome, @, hashtag ou o 22 como voto |
| `2` | Pediu voto no Flávio ("vote 22", "dia 25 é Flávio"...) |

Vídeos também contam pelo que é **falado**. Nesses casos o post vem marcado como `citado_na_fala_do_video` e traz o `trecho_transcrito`.

**Cargos:** `gov` governador(a) · `sen` senador(a) · `fed` deputado(a) federal · `est` deputado(a) estadual · `pref` prefeito(a)

**Situação:** `eleito` eleito(a) em 2026 · `2t` disputa o 2º turno · `mandato` em mandato (não disputou em 2026)

**Redes:** `ig` Instagram · `fb` Facebook · `x` X/Twitter · `th` Threads · `yt` YouTube · `tt` TikTok · `kw` Kwai · `tg` Telegram

**`sq`:** código sequencial do candidato no TSE, usado como identificador único de cada político.

## Limitações conhecidas

- **Depende da estrutura do site.** Se o Flaviômetro mudar o HTML ou o formato do feed, o servidor quebra até ser ajustado.
- **A classificação é do site.** Se um post foi classificado errado lá, ele aparece errado aqui. Este projeto não reclassifica nada.
- **Janela limitada.** O feed só cobre um período recente (informado em `feed_cobre_desde` no `resumo_geral`), não o histórico completo.
- **Posts sem citação vêm resumidos.** Para posts de nível `0`, o feed só informa que existiram (data e rede), sem texto, link ou métricas.
- **Métricas incompletas.** Visualizações, curtidas e compartilhamentos dependem do que cada rede expõe e podem vir `null`.
- **Números podem divergir do site.** O site aplica filtros visuais próprios (e agrupa versões do mesmo conteúdo publicado em várias redes). Aqui cada post conta individualmente.
- **Vínculo com o CNPJ por nome.** O arquivo de CNPJs do TSE não traz o código do candidato. Homônimos no mesmo cargo são desempatados pela UF, e vínculos aproximados vêm sinalizados.
- **Campo `cobertura`.** O feed traz um par de datas por político cujo significado exato não é documentado. Ele aparece como `cobertura_informada_pelo_feed` e deve ser tratado como indicativo.

## Desenvolvimento

```bash
npm run dev        # recompila a cada alteração
npm run build      # compila para dist/
npm run inspector  # abre o MCP Inspector apontando para dist/index.js
```

Estrutura:

```
src/
├── index.ts    # registro das ferramentas MCP e transporte stdio
├── fonte.ts    # download (com suporte a proxy), extração do cadastro e cache
├── analise.ts  # agregações, filtros, rótulos e formatação em pt-BR
└── tse.ts      # bases do TSE, vínculo candidato ↔ CNPJ e consulta ao OpenCNPJ
```

Logs vão para `stderr`, já que `stdout` é reservado ao protocolo MCP.

## Uso responsável

- O servidor é feito para **uso pessoal e local**. Ele baixa o feed no máximo uma vez a cada intervalo de cache e se identifica com um `User-Agent` próprio. Evite reduzir o cache a valores muito baixos.
- O site marca suas páginas como `noindex`. Respeite a infraestrutura de quem mantém o Flaviômetro e não use este projeto para raspagem em massa nem para republicar os dados como se fossem seus.
- Ao divulgar números obtidos por aqui, **cite o Flaviômetro como fonte** e deixe claro que a extração foi feita por uma ferramenta não oficial.
- Os dados tratam de figuras públicas e posts públicos, mas use o bom senso: confira no post original antes de afirmar qualquer coisa sobre alguém.
- Os contatos de campanha são dados públicos, mas continuam protegidos pela **LGPD**. Use para contato legítimo (imprensa, pesquisa, fiscalização) e **não para envio em massa, spam ou montagem de listas**. A ferramenta consulta um candidato por vez de propósito.
- O OpenCNPJ é um projeto gratuito e sem fins lucrativos, feito para consultas pontuais. Não use este servidor para varrer CNPJs em lote.

## Licença

[MIT](https://opensource.org/license/mit). Vale para o código deste repositório, não para os dados do Flaviômetro, do TSE ou do OpenCNPJ, que pertencem aos seus respectivos responsáveis.
