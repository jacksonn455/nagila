/* Render jornais (newspapers/media) section from local data
   Simple vertical list of verified media publications featuring Nagila Zortea

   A lista abaixo espelha data/jornais.json e serve de fallback: fetch() falha
   em preview local via file:// e retorna 404 se o JSON não estiver publicado.
   Ao editar o JSON, replicar aqui (mesmo padrão de interviews.js).
*/
(function () {
  'use strict';

  const defaultJornais = [
    {
      id: 'uri-estetika-2026',
      title: 'Professora palestra no Estetika, referência latino-americana em estética',
      description:
        'Nágila Zortéa foi palestrante na 32ª edição do Estetika — o maior evento de estética da América Latina —, realizado no São Paulo Expo. Apresentou a palestra "Olhar integrativo na saúde além da pele" e participou da mesa-redonda "Hot Topics na Estética Facial".',
      source: 'URI Erechim — Notícias',
      url: 'https://www.uricer.edu.br/site/informacao_noticia.php?id=12573',
      date: '2026-08-05',
      category: 'portal',
    },
    {
      id: 'jornal-bom-dia-beauty-fair-2025',
      title:
        'Profissionais de Erechim participam de Missão Empresarial à Beauty Fair 2025 em São Paulo',
      description:
        'Matéria sobre a Missão Empresarial que levou profissionais e estudantes do setor de beleza de Erechim à Beauty Fair, a maior feira das Américas, em São Paulo.',
      source: 'Jornal Bom Dia',
      url: 'https://www.jornalbomdia.com.br/noticia/82392/profissionais-de-erechim-participam-de-missao-empresarial-a-beauty-fair-2025-em-sao-paulo',
      date: null,
      category: 'jornal',
    },
    {
      id: 'uri-tricologia-2025',
      title: 'Curso de Estética e Cosmética promove aula especial sobre Tricologia',
      description:
        'Notícia sobre aula especial de Tricologia promovida pelo Curso de Estética e Cosmética da URI Erechim. Nágila Zortéa, coordenadora do curso, destacou a importância da iniciativa para a formação dos futuros profissionais.',
      source: 'URI Erechim — Notícias',
      url: 'https://www.uricer.edu.br/site/informacao_noticia.php?id=11900',
      date: '2025-07-14',
      category: 'portal',
    },
    {
      id: 'jornal-bom-dia-outubro-rosa',
      title: 'Outubro Rosa: Um dia de cuidado e autoestima',
      description:
        'Matéria sobre atividade especial realizada em homenagem ao Outubro Rosa, mês de conscientização sobre o câncer de mama e a saúde feminina, com participação de funcionárias da URI.',
      source: 'Jornal Bom Dia',
      url: 'https://www.jornalbomdia.com.br/noticia/74400/outubro-rosa-um-dia-de-cuidado-e-autoestima',
      date: null,
      category: 'jornal',
    },
    {
      id: 'jornal-bom-dia-diplomada-uri',
      title: 'Diplomada fala da importância de ter feito o curso de Estética e Cosmética na URI',
      description:
        'Matéria em que uma egressa do Curso de Estética e Cosmética da URI Erechim fala sobre a importância da formação para sua trajetória profissional.',
      source: 'Jornal Bom Dia',
      url: 'https://www.jornalbomdia.com.br/noticia/62923/diplomada-fala-da-importancia-de-ter-feito-o-curso-de-estetica-e-cosmetica-na-uri',
      date: null,
      category: 'jornal',
    },
  ];

  async function fetchJornais() {
    try {
      if (window.__JORNAIS__ && Array.isArray(window.__JORNAIS__)) {
        return window.__JORNAIS__;
      }

      const res = await fetch('./data/jornais.json', { cache: 'no-store' });
      if (!res.ok) return defaultJornais;
      const data = await res.json();
      return Array.isArray(data) && data.length ? data : defaultJornais;
    } catch {
      // file:// bloqueia fetch — usa a lista embutida
      return defaultJornais;
    }
  }

  function sortByDate(jornais) {
    // Cópia: não mutar defaultJornais nem os dados recebidos
    return jornais.slice().sort((a, b) => {
      // Items with dates first (most recent first)
      if (a.date && b.date) {
        return new Date(b.date) - new Date(a.date);
      }
      // Items without dates go to the end
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const lang = window.I18n?.lang || 'pt';
      const localeMap = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' };
      const locale = localeMap[lang] || 'pt-BR';
      const date = new Date(dateStr + 'T00:00:00');
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(date);
    } catch {
      return dateStr;
    }
  }

  function createJornalCard(item) {
    const article = document.createElement('article');
    article.className = 'jornal-card';
    article.setAttribute('data-reveal', '');

    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'jornal-card__link';

    const titleEl = document.createElement('h3');
    titleEl.className = 'jornal-card__title';
    titleEl.textContent = item.title;
    link.appendChild(titleEl);

    if (item.description) {
      const descEl = document.createElement('p');
      descEl.className = 'jornal-card__description';
      descEl.textContent = item.description;
      link.appendChild(descEl);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'jornal-card__meta';

    if (item.source) {
      const sourceEl = document.createElement('span');
      sourceEl.className = 'jornal-card__source';
      sourceEl.textContent = item.source;
      metaEl.appendChild(sourceEl);
    }

    if (item.date) {
      const dateEl = document.createElement('span');
      dateEl.className = 'jornal-card__date';
      dateEl.textContent = formatDate(item.date);
      metaEl.appendChild(dateEl);
    }

    link.appendChild(metaEl);
    article.appendChild(link);
    return article;
  }

  async function renderJornais() {
    const container = document.querySelector('.jornais__list');
    if (!container) return;

    const jornais = await fetchJornais();
    if (jornais.length === 0) return;

    container.innerHTML = '';
    const sorted = sortByDate(jornais);
    const fragment = document.createDocumentFragment();
    const cards = [];

    sorted.forEach((item, index) => {
      const card = createJornalCard(item);
      // Escalonamento da animação de entrada (CSS define data-delay 1..4)
      if (index > 0) card.setAttribute('data-delay', String(Math.min(index, 4)));
      cards.push(card);
      fragment.appendChild(card);
    });

    container.appendChild(fragment);

    /* Os cards entram no DOM depois do RevealManager.init(), então precisam
       ser registrados manualmente — senão ficam com opacity: 0 para sempre. */
    if (window.RevealManager) {
      window.RevealManager.observe(cards);
    } else {
      cards.forEach((card) => card.setAttribute('data-reveal', 'visible'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderJornais);
  } else {
    renderJornais();
  }

  document.addEventListener('languagechange', renderJornais);
})();
