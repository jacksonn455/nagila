/* Render interviews section from local data
   Uses existing site styles (cards) to keep visual consistency.
   This avoids fetch() failures on file:// local previews.
*/
(function(){
  'use strict';

  const defaultInterviews = [
    {
      id: 'viver-com-saude',
      title: 'VIVER COM SAÚDE 14/06/2024 • NAGILA ZORTEA',
      program: 'TVErechim - VIVER COM SAÚDE',
      date: '2024-06-14',
      youtubeUrl: 'https://www.youtube.com/watch?v=nSwZBlSijKk',
      youtubeId: 'nSwZBlSijKk',
      thumbnail: './assets/images/entrevista.png',
      description: 'Entrevista na TV Erechim sobre o mês de conscientização do lipedema e a importância do alerta sobre a condição.'
    },
    {
      id: 'expressao-universitaria-717',
      title: '717 º EXPRESSÃO UNIVERSITÁRIA 18/06/25 - Lipedema',
      program: 'URI Erechim - Expressão Universitária',
      date: '2025-06-18',
      youtubeUrl: 'https://www.youtube.com/watch?v=SW1aZiLB4J8',
      youtubeId: 'SW1aZiLB4J8',
      thumbnail: './assets/images/entrevista.png',
      description: 'Participação no programa universitário em torno do Dia Mundial de Conscientização do Lipedema.'
    },
    {
      id: 'quiz-uri',
      title: 'URI Erechim - Estética e cosmetica com Prof. Nágila Zortea',
      program: 'URI Erechim',
      date: null,
      youtubeUrl: 'https://www.youtube.com/watch?v=Rds1KWwkJok',
      youtubeId: 'Rds1KWwkJok',
      thumbnail: './assets/images/entrevista.png',
      description: 'Participação em conteúdo institucional da URI sobre formação e mercado profissional de estética e cosmética.'
    }
  ];

  async function fetchInterviews(){
    try {
      if (window.__INTERVIEWS__ && Array.isArray(window.__INTERVIEWS__)) {
        return window.__INTERVIEWS__;
      }

      const res = await fetch('./data/interviews.json', { cache: 'no-store' });
      if (!res.ok) return defaultInterviews;
      const data = await res.json();
      return Array.isArray(data) ? data : defaultInterviews;
    } catch (e) {
      return defaultInterviews;
    }
  }

  const INTERVIEW_IMAGE = './assets/images/entrevista.png';

  function createCard(item){
    const article = document.createElement('article');
    article.className = 'event-featured';
    article.setAttribute('aria-labelledby', `interview-${item.id}-title`);

    const description = item.description ? `<p class="event-card__desc">${item.description}</p>` : '';
    const dateMarkup = item.date ? `<p class="event-card__location"><span>${item.date}</span></p>` : '';

    article.innerHTML = `
      <img src="${INTERVIEW_IMAGE}" alt="Entrevista — ${item.title}" width="780" height="438" class="event-featured__image" loading="lazy">
      <div class="event-card__content">
        <p class="event-card__event-name">${item.program}</p>
        <h3 id="interview-${item.id}-title" class="event-card__title">${item.title}</h3>
        ${dateMarkup}
        ${description}
        <div class="tags">
          <a class="btn btn--primary" href="${item.youtubeUrl}" target="_blank" rel="noopener noreferrer">Assistir entrevista</a>
        </div>
      </div>
    `;

    return article;
  }

  async function init(){
    const list = document.querySelector('.interviews__list');
    if(!list) return;
    const data = await fetchInterviews();
    if(!Array.isArray(data) || !data.length){
      list.innerHTML = '<p style="color:var(--text-muted)">Nenhuma entrevista disponível no momento.</p>';
      return;
    }

    list.innerHTML = '';
    data.forEach(item => list.appendChild(createCard(item)));
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
