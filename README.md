# Portfólio Profissional — Nágila Bernarda Zortéa

Site estático (HTML + CSS + JS puro) do portfólio profissional de **Nágila Bernarda Zortéa** — Mestre, Esteticista, Coordenadora do Curso de Estética e Cosmética e da Pós-Graduação em Estética Avançada da URI Erechim, e responsável pela NZ Beauty Clinic em Erechim/RS.

---

## Stack

- **HTML / CSS / JavaScript** — sem frameworks, sem bundlers, sem dependências em produção
- **Fontes**: Google Fonts — Cormorant Garamond (serif) + DM Sans (sans-serif)
- **Build**: Node.js scripts (`scripts/`)
- **Dev**: servidor estático local (`npm run dev`)
- **Qualidade**: html-validate + Prettier

---

## Como executar localmente

```bash
# Instalar dependências de desenvolvimento
npm install

# Iniciar servidor de desenvolvimento em http://localhost:4173
npm run dev
```

O servidor espelha o comportamento do GitHub Pages (gzip, rota 404 customizada).

---

## Como fazer o build

```bash
# Gera o sitemap.xml a partir dos dados
npm run build
```

---

## Como atualizar os dados

Todos os dados estão em `data/`. Edite os arquivos JSON e o site reflete as mudanças automaticamente:

| Arquivo                  | Conteúdo                                        |
| ------------------------ | ----------------------------------------------- |
| `data/profile.json`      | Informações pessoais e institucionais de Nágila |
| `data/publications.json` | Publicações científicas                         |
| `data/events.json`       | Palestras e eventos                             |
| `data/clinic.json`       | Dados da NZ Beauty Clinic                       |

**Regra fundamental**: só incluir informações que podem ser confirmadas por fontes públicas verificadas.

---

## Como adicionar uma nova publicação

1. Abra `data/publications.json`
2. Adicione um novo objeto ao array seguindo a estrutura existente
3. Campos obrigatórios: `id`, `title`, `authors`, `journal`, `year`, `abstract`
4. Campos recomendados: `doi`, `url`, `urlPdf`
5. Se a informação não estiver confirmada, adicione `"dataNote": "TODO: validar"`
6. Adicione o card correspondente em `index.html` na seção `#publicacoes`

---

## Como adicionar um evento ou palestra

1. Abra `data/events.json`
2. Adicione um novo objeto ao array seguindo a estrutura existente
3. Campos obrigatórios: `id`, `title`, `event`, `type`, `date`, `description`, `source`
4. Adicione o card correspondente em `index.html` na seção `#palestras`

---

## Como atualizar o SEO

- **Título e description da home**: `index.html` — tags `<title>` e `<meta name="description">`
- **Open Graph**: `index.html` — tags `og:*`
- **JSON-LD**: `index.html` — bloco `<script type="application/ld+json">`
- **Sitemap**: `sitemap.xml` (ou executar `npm run build` para gerar automaticamente)
- **robots.txt**: arquivo raiz — já está configurado para permitir todos os crawlers
- **llms.txt**: arquivo raiz — resumo legível por sistemas de IA

---

## Como fazer deploy

### GitHub Pages

1. Faça push do repositório para o GitHub
2. Em **Settings → Pages**, selecione o branch `main` e a pasta raiz `/`
3. Para domínio personalizado, adicione o domínio no arquivo `CNAME`

### Outros serviços

O site é 100% estático. Qualquer CDN ou serviço de hospedagem estática funciona:

- **Netlify**: arraste a pasta do projeto ou conecte via Git
- **Vercel**: conecte o repositório, configuração automática
- **Cloudflare Pages**: conecte o repositório Git

---

## Verificações antes do deploy

```bash
# Validação HTML
npm run check:html

# Verificação de links externos
npm run check:links

# Formatação de código
npm run check:format
npm run format   # corrige automaticamente
```

---

## Estrutura de pastas

```
nagila/
├── index.html            # Página principal (single-page portfolio)
├── 404.html              # Página de erro (GitHub Pages)
├── robots.txt            # Permissões de crawling
├── sitemap.xml           # Sitemap XML para SEO
├── llms.txt              # Resumo para sistemas de IA (GEO)
├── package.json
├── data/
│   ├── profile.json      # Dados da Nágila
│   ├── publications.json # Publicações científicas
│   ├── events.json       # Palestras e eventos
│   └── clinic.json       # NZ Beauty Clinic
├── assets/
│   ├── css/main.css      # Design system completo
│   ├── js/app.js         # Tema, nav, FAQ, animações
│   └── img/              # Imagens (adicionar WebP/AVIF)
├── scripts/
│   ├── serve.js          # Servidor de desenvolvimento
│   ├── build-sitemap.js  # Gerador de sitemap
│   └── check-links.js    # Verificador de links externos
└── README.md
```

---

## Identidade visual

| Variável         | Light Mode             | Dark Mode               |
| ---------------- | ---------------------- | ----------------------- |
| `--bg`           | `#fafaf7` (ivory)      | `#0a0a0a` (black)       |
| `--text`         | `#1a1714` (warm black) | `#f5f0e8` (ivory)       |
| `--accent`       | `#8b6914` (dark gold)  | `#c9a84c` (gold)        |
| `--accent-vivid` | `#c9a84c` (gold)       | `#d4b55a` (bright gold) |

---

## TODO — Pendente de validação

- [ ] Foto profissional de Nágila (substituir placeholder)
- [ ] Imagens da NZ Beauty Clinic
- [ ] Imagens do Estetika 2026
- [ ] Favicon personalizado
- [ ] OG image (1200×630px)
- [ ] Domínio personalizado (`CNAME`)
- [ ] Horário completo de funcionamento da clínica
- [ ] Lista completa de serviços da clínica
- [ ] Ano exato da publicação "Fatores Bioquímicos do Melasma"
- [ ] Nome completo do periódico da revisão sobre radiofrequência (2021)
- [ ] Verificar outras palestras e eventos que possam ter ocorrido
