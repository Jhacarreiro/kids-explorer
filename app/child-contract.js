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
    maxAnswerChars: 512,
    maxTopicChars: 24,
    maxFollowupChars: 128,
  });

  // Provider-agnostic instructions sent with every query (voice, photo or
  // text). `age` is the child's age chosen by an adult on the device.
  function childInstructions(age = DEFAULT_CHILD_AGE) {
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
      'Se a criança disser «não sei», «conta-me uma coisa», «surpreende-me» ou algo parecido, conta-lhe uma curiosidade verdadeira e surpreendente.',
      'Se receberes a conversa anterior, usa-a para perceber respostas curtas como «sim», «o primeiro», «e porquê?» ou perguntas sobre a foto anterior. Responde só à pergunta nova.',
      'Aplica estas regras a «answer», «topic» e «followups». Revê silenciosamente o português de Portugal antes de devolver o JSON.',
      'Devolve APENAS um objeto JSON válido (sem markdown, sem texto extra) com esta forma exata:',
      '{"topic": "...", "answer": "...", "followups": ["...", "..."]}',
      'Regras:',
      '- "topic": uma única palavra curta, em MAIÚSCULAS e sem acentos, com o tema principal.',
      '- "answer": 2 a 4 frases curtas, alegres e fáceis de ouvir, com no máximo 450 caracteres; sem markdown, sem ligações, sem emojis.',
      '- "followups": no máximo 2 temas que a criança pode pedir a seguir, cada um com poucas palavras; vão ser lidos como «Queres saber mais sobre X ou sobre Y?».',
      '- Fala de um só conceito de cada vez.',
      '- Se a pergunta ou a foto não for clara, responde com honestidade, num tom gentil.',
    ].join('\n');
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

  // Enforces the child-response contract on raw model output. Returns null
  // for anything that cannot be sanitized: callers fail explicitly, never
  // with a made-up answer.
  function parseChildResponse(raw, limits = DEFAULT_LIMITS) {
    let parsed;
    try {
      parsed = JSON.parse(extractJsonBlock(raw));
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.topic !== 'string' || typeof parsed.answer !== 'string') return null;
    const topic = normalizeTopic(parsed.topic, limits);
    const answer = truncateSpoken(stripMarkdown(parsed.answer), limits.maxAnswerChars);
    if (!topic || !answer) return null;
    return { topic, answer, followups: normalizeFollowups(parsed.followups, limits) };
  }

  return {
    DEFAULT_CHILD_AGE,
    DEFAULT_LIMITS,
    childInstructions,
    parseChildResponse,
    spokenText,
    truncateSpoken,
    withConversation,
  };
}));
