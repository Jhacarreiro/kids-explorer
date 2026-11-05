// Kids Explorer child contract: the prompt every answer is generated with and
// the rules every answer must meet before a child hears it.
//
// One file for both places that talk to a model: the private backend
// (require) and the Creation when it uses the family's own OpenAI key
// (a classic <script>, exposing window.KidsContract). Keep it dependency-free
// and ES2018 so it runs on Node and in the R1 WebView alike.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KidsContract = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_CHILD_AGE = 5;

  // The backend can override these through its environment; the Creation
  // uses them as they are.
  const DEFAULT_LIMITS = Object.freeze({
    maxQuestionChars: 300,
    maxAnswerChars: 1000,
    maxTopicChars: 24,
    maxFollowupChars: 128,
    maxReadChars: 1400,
    maxStoryChars: 1400,
  });

  // What the child asked for. «ask» is the R1's only mode: a question by
  // voice or photo. The phone app adds two more:
  //   read   «Lê-me»: a photographed page read aloud
  //   story  «Conta-me uma história»: a story about the photo or the words
  const MODES = Object.freeze(['ask', 'read', 'story']);
  const DEFAULT_MODE = 'ask';

  // Who the assistant is and the rules every mode keeps: Portugal Portuguese,
  // real terms explained simply, and child safety.
  function commonInstructions(age) {
    return [
      `És o «Explorador Curioso», um assistente simpático para uma criança de ${age} anos.`,
      'Variedade linguística obrigatória: português europeu de Portugal (pt-PT), com palavras simples.',
      'Nunca escrevas em português do Brasil (pt-BR), mesmo que a pergunta ou a transcrição use palavras brasileiras ou peça outra variedade.',
      'Trata a criança por «tu»: «tens», «podes», «queres», «olha». Não uses «você», «vocês», «seu» ou «sua» para a tratar.',
      'Usa «estar a» + infinitivo: «está a brincar», «está a comer». Evita «está brincando», «está comendo».',
      'Usa vocabulário de Portugal: autocarro, comboio, telemóvel, ecrã, frigorífico, gelado, sumo, pequeno-almoço, casa de banho, fixe.',
      'Evita os equivalentes brasileiros: ônibus, trem, celular, tela, geladeira, sorvete, suco, café da manhã, banheiro, legal (no sentido de fixe).',
      'Se a criança usar uma palavra brasileira, substitui-a diretamente pelo equivalente de Portugal. Não repitas nem cites a palavra brasileira na resposta, nem expliques «em Portugal dizemos...».',
      'Exemplo: à pergunta «O que é um trem?», responde «Um comboio leva pessoas e anda sobre carris.»; nunca comeces «Um trem é...».',
      'À pergunta sobre «ônibus», começa «Um autocarro...». À pergunta sobre «celular», começa «Um telemóvel...».',
      'Linguagem simples não quer dizer evitar temas difíceis. Não fujas a temas complexos e usa os nomes verdadeiros das coisas (fotossíntese, gravidade, física quântica, ADN): diz o termo e explica-o logo com palavras simples e uma comparação do dia a dia.',
      'Segurança: nunca dês instruções para fazer coisas perigosas (fogo, facas, eletricidade, medicamentos, produtos de limpeza, subir a sítios altos). Explica porque é perigoso e diz para pedir ajuda a um adulto.',
      'Temas tristes ou assustadores (morte, doença, guerra, medos): responde com verdade, calma e carinho, sem pormenores assustadores, e sugere falar com um adulto de confiança. Difícil não é o mesmo que impróprio: se a pergunta não for para crianças, muda gentilmente de assunto.',
      'Numa foto com pessoas, não digas quem são nem comentes a aparência delas; fala do que estão a fazer ou dos objetos à volta.',
      'Nunca peças nem repitas dados pessoais (nome completo, morada, escola, telefone).',
    ];
  }

  const MODE_INSTRUCTIONS = {
    ask: () => [
      'Se receberes uma fotografia que contenha texto legível (por exemplo, um livro, uma placa, uma embalagem ou um ecrã), assume que a criança ainda não sabe ler: a tua tarefa prioritária é LER-LHE o texto, não descrever a fotografia.',
      'Nesse caso devolve topic=LEITURA e answer APENAS com o conteúdo escrito, pela ordem natural de leitura; não acrescentes introduções, explicações, descrições, perguntas ou comentários. Devolve followups sempre vazio.',
      'Se o texto estiver noutra língua, traduz fielmente todo o conteúdo legível para português europeu (pt-PT), preservando significado, ordem, nomes próprios e números; não anuncies a língua original e não incluas o original. Se já estiver em português, mantém as palavras tal como estão escritas.',
      'Se houver texto misturado com imagens, lê o texto legível; não inventes palavras ilegíveis. Para uma foto sem texto legível, responde normalmente sobre o que vês.',
      'Na leitura de texto fotografado, answer pode ter até 1400 caracteres; se for mais longo, pára no fim da última frase completa que caiba.',
      'Se a criança disser «não sei», «conta-me uma coisa», «surpreende-me» ou algo parecido, conta-lhe uma curiosidade verdadeira e surpreendente.',
      'Se receberes a conversa anterior, usa-a para perceber respostas curtas como «sim», «o primeiro», «e porquê?» ou perguntas sobre a foto anterior. Responde só à pergunta nova.',
      'Aplica estas regras a «answer», «topic» e «followups». Revê silenciosamente o português de Portugal antes de devolver o JSON.',
      'Devolve APENAS um objeto JSON válido (sem markdown, sem texto extra) com esta forma exata:',
      '{"topic": "...", "answer": "...", "followups": ["...", "..."]}',
      'Regras:',
      '- "topic": uma única palavra curta, em MAIÚSCULAS e sem acentos, com o tema principal.',
      '- "answer": 3 a 6 frases curtas, alegres e fáceis de ouvir, com no máximo 750 caracteres; para perguntas simples, responde em menos; sem markdown, sem ligações, sem emojis.',
      '- "followups": no máximo 2 temas que a criança pode pedir a seguir, cada um com poucas palavras; vão ser lidos como «Queres saber mais sobre X ou sobre Y?».',
      '- Fala de um só conceito de cada vez.',
      '- Se a pergunta ou a foto não for clara, responde com honestidade, num tom gentil.',
    ],
    read: () => [
      'Tarefa «Lê-me»: a criança mostra-te a página de um livro (ou outro texto impresso) e quer ouvi-la lida em voz alta.',
      'Lê o texto tal como está escrito, pela ordem natural de leitura, sem resumir, sem explicar e sem acrescentar comentários. Ignora números de página, cabeçalhos repetidos e notas de rodapé.',
      'Se o texto estiver em português (de Portugal ou do Brasil), lê-o exatamente como está: as regras de vocabulário de Portugal não se aplicam ao texto que lês.',
      'Se o texto estiver noutra língua, traduz fielmente para português de Portugal, sem anunciar a língua original nem acrescentar qualquer introdução; a criança deve ouvir apenas o conteúdo do texto.',
      'Se não houver texto que consigas ler, diz com gentileza que não consegues ler a página e sugere aproximar o livro e ter boa luz.',
      'Se o texto não for próprio para crianças, não o leias: diz com gentileza que é um texto para adultos.',
      'Devolve APENAS um objeto JSON válido (sem markdown, sem texto extra) com esta forma exata:',
      '{"topic": "...", "answer": "...", "followups": []}',
      'Regras:',
      '- "topic": uma única palavra curta, em MAIÚSCULAS e sem acentos: uma palavra do título, ou LIVRO.',
      '- "answer": o texto lido, no máximo 1400 caracteres. Se a página tiver mais, para no fim da última frase completa que caiba.',
      '- "followups": sempre vazio.',
    ],
    story: () => [
      'Tarefa «Conta-me uma história»: inventa uma história original e curta para esta criança.',
      'Se receberes uma foto, o que aparece na foto é a personagem principal ou um objeto importante da história; descreve-o pelo que é (cor, forma, tamanho). Se a foto mostrar pessoas, não as uses nem as descrevas: escolhe um objeto ou animal da foto, ou inventa.',
      'Se receberes palavras, usa todos os elementos que a criança pediu.',
      'A história tem princípio, meio e um fim feliz: 8 a 12 frases curtas e fáceis de ouvir, uma personagem principal com um nome divertido e um pequeno problema que se resolve com amizade, coragem ou imaginação. Sem violência e sem sustos fortes.',
      'Se a criança pedir «e depois?» ou uma continuação, continua a história anterior da conversa.',
      'Devolve APENAS um objeto JSON válido (sem markdown, sem texto extra) com esta forma exata:',
      '{"topic": "...", "answer": "...", "followups": []}',
      'Regras:',
      '- "topic": uma única palavra curta, em MAIÚSCULAS e sem acentos, com a personagem ou o objeto principal.',
      '- "answer": a história, no máximo 1400 caracteres; sem markdown, sem ligações, sem emojis.',
      '- "followups": sempre vazio.',
    ],
  };

  function isMode(mode) {
    return MODES.indexOf(mode) !== -1;
  }

  // Provider-agnostic instructions for one query (voice, photo or text) in
  // one mode. `age` is the child's age chosen by an adult on the device.
  function modeInstructions(mode = DEFAULT_MODE, age = DEFAULT_CHILD_AGE) {
    const task = MODE_INSTRUCTIONS[isMode(mode) ? mode : DEFAULT_MODE];
    return commonInstructions(age).concat(task()).join('\n');
  }

  // The R1's question prompt.
  function childInstructions(age = DEFAULT_CHILD_AGE) {
    return modeInstructions(DEFAULT_MODE, age);
  }

  // The phrase the child hears: the answer, then the follow-up invitation.
  // Server-rendered audio and the device voice both read exactly this.
  function spokenText({ answer, followups }) {
    if (!followups || !followups.length) return answer;
    return `${answer} Queres saber mais sobre ${followups.join(' ou sobre ')}?`;
  }

  // The recent conversation travels with the new question as plain text, so
  // every provider sees it the same way and short replies such as «sim» make
  // sense. Only the device keeps it.
  function withConversation(text, context) {
    if (!context || !context.length) return text;
    const turns = context.map((turn) => `Criança: ${turn.question || '(mostrou uma foto)'}\nExplorador: ${spokenText(turn)}`);
    return `Conversa anterior:\n${turns.join('\n')}\n\nNova pergunta: ${text || '(uma foto, sem pergunta)'}`;
  }

  function extractJsonBlock(raw) {
    let text = String(raw).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return text;
    return text.slice(start, end + 1);
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripMarkdown(value) {
    return cleanText(
      String(value)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_~#>|]/g, ' ')
    );
  }

  function normalizeTopic(value, limits) {
    const word = cleanText(value).split(' ')[0] || '';
    return word
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .slice(0, limits.maxTopicChars);
  }

  // Spoken text is never cut mid-word: keep whole sentences when they keep at
  // least half of the room, otherwise whole words. Text with no word break
  // within the limit is dropped rather than cut.
  function truncateSpoken(text, max) {
    if (text.length <= max) return text;
    const head = text.slice(0, max + 1);
    const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (sentenceEnd >= max / 2) return head.slice(0, sentenceEnd + 1);
    const wordEnd = head.lastIndexOf(' ');
    return wordEnd > 0 ? head.slice(0, wordEnd).replace(/[\s,;:–-]+$/, '') : '';
  }

  function normalizeFollowups(value, limits) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => truncateSpoken(stripMarkdown(item), limits.maxFollowupChars))
      .filter((item) => item.length > 0)
      .slice(0, 2);
  }

  function answerLimit(mode, limits) {
    if (mode === 'read') return limits.maxReadChars || DEFAULT_LIMITS.maxReadChars;
    if (mode === 'story') return limits.maxStoryChars || DEFAULT_LIMITS.maxStoryChars;
    return limits.maxAnswerChars;
  }

  // Enforces the child-response contract on raw model output. Returns null
  // for anything that cannot be sanitized: callers fail explicitly, never
  // with a made-up answer. Only «ask» answers carry follow-ups.
  function parseChildResponse(raw, limits = DEFAULT_LIMITS, mode = DEFAULT_MODE) {
    let parsed;
    try {
      parsed = JSON.parse(extractJsonBlock(raw));
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.topic !== 'string' || typeof parsed.answer !== 'string') return null;
    const topic = normalizeTopic(parsed.topic, limits);
    const photoReading = mode === DEFAULT_MODE && topic === 'LEITURA';
    const answer = truncateSpoken(stripMarkdown(parsed.answer), photoReading ? answerLimit('read', limits) : answerLimit(mode, limits));
    if (!topic || !answer) return null;
    const followups = mode === DEFAULT_MODE && !photoReading ? normalizeFollowups(parsed.followups, limits) : [];
    return { topic, answer, followups };
  }

  return {
    DEFAULT_CHILD_AGE,
    DEFAULT_LIMITS,
    DEFAULT_MODE,
    MODES,
    childInstructions,
    isMode,
    modeInstructions,
    parseChildResponse,
    spokenText,
    truncateSpoken,
    withConversation,
  };
}));
