'use strict';

// Builds the R1 installation QR for the family's own keys. The QR holds the
// JSON object Rabbit's QR installer reads; the keys travel in the URL
// fragment, which the R1 never sends to the page's host.
(function () {
  const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,300}$/;
  const AZURE_KEY_PATTERN = /^[A-Za-z0-9]{32,128}$/;
  const AZURE_REGION_PATTERN = /^[a-z0-9]{2,40}$/;
  // The Creation is published next to this page: <site>/app/.
  const CREATION_URL = new URL('../app/', window.location.href);

  const form = document.getElementById('keys');
  const fields = {
    openai: document.getElementById('openai'),
    azure: document.getElementById('azure'),
    region: document.getElementById('region'),
  };
  const error = document.getElementById('error');
  const result = document.getElementById('result');
  const image = document.getElementById('qr');

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    result.hidden = true;
    image.removeAttribute('src');
  }

  function installUrl(keys) {
    const fragment = new URLSearchParams({ openai: keys.openai });
    if (keys.azure) {
      fragment.set('azure', keys.azure);
      fragment.set('region', keys.region);
    }
    // A new v for each build makes the R1 load the current Creation.
    const url = new URL(CREATION_URL);
    url.search = '?v=' + Date.now().toString(36);
    url.hash = fragment.toString();
    return url.toString();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const keys = {
      openai: fields.openai.value.trim(),
      azure: fields.azure.value.trim(),
      region: fields.region.value.trim().toLowerCase(),
    };
    if (!OPENAI_KEY_PATTERN.test(keys.openai)) {
      showError('A chave da OpenAI começa por «sk-». Copia-a outra vez da página da OpenAI.');
      return;
    }
    if (keys.azure || keys.region) {
      if (!AZURE_KEY_PATTERN.test(keys.azure) || !AZURE_REGION_PATTERN.test(keys.region)) {
        showError('Para a voz de Portugal são precisas a chave e a região do Azure Speech, por exemplo westeurope. Deixa as duas em branco para usar a voz do R1.');
        return;
      }
    }
    const payload = JSON.stringify({
      title: 'Explorador Curioso',
      url: installUrl(keys),
      description: 'Pergunta por voz ou com uma foto',
      iconUrl: '',
      themeColor: '#5BC8F5',
    });
    const qr = window.qrcode(0, 'L');
    qr.addData(payload, 'Byte');
    qr.make();
    image.src = qr.createDataURL(6, 4);
    error.hidden = true;
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('clear').addEventListener('click', () => {
    form.reset();
    image.removeAttribute('src');
    result.hidden = true;
  });
}());
