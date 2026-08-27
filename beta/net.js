/* =========================================================================
   net.js — camada de conexão com o Supabase (v1 do teste ponta a ponta)
   O motor de cálculo continua no cliente; aqui só cuidamos de:
     1. entrar (login anônimo — sem digitar nada)
     2. espelhar o MEU jogador no banco (upsert)
     3. listar adversários reais (outros aparelhos que abriram o app)
   Passos 4 e 5 (mandar partida, receber+confirmar) entram depois, aqui mesmo.
   A chave abaixo é a "publishable" — pública por design, pode ficar no cliente.
   ========================================================================= */
// ⚠️ RANKET (branch de desenvolvimento) — banco PRÓPRIO, separado da produção.
// Estas duas linhas são o ÚNICO ponto em que a branch `ranket` diverge da `main`
// de propósito, e NUNCA podem entrar num merge pra main. A produção (main) usa
// o projeto ogeeholzwptvyjfqpwfi; aqui é o nphyenpxzxysoefdvorn.
const SB_URL = 'https://nphyenpxzxysoefdvorn.supabase.co';
const SB_KEY = 'sb_publishable_EVjpT6x7IhLYhuza64MTbA_Ne-0qj47';

// supabase-js é carregado por <script> CDN antes deste arquivo → expõe `supabase`
const sb = supabase.createClient(SB_URL, SB_KEY);

// meu uid da sessão (= id do meu player). Preenchido no netEntrar().
let MEU_UID = null;

/* 1. Sessão atual (email+senha). Valida que a conta AINDA existe no servidor —
   se foi apagada (ex.: reset do banco), o crachá velho fica no aparelho e o app
   acharia que está logado. Nesse caso desloga, limpa o estado e recomeça. */
async function netEntrar(){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session){ MEU_UID=null; return null; }
  const { data:{ user }, error } = await sb.auth.getUser();
  if(error || !user){
    await sb.auth.signOut();
    try{ localStorage.removeItem('appTenis'); }catch(e){}
    MEU_UID=null;
    location.reload();
    return null;
  }
  MEU_UID = user.id;
  return MEU_UID;
}

/* Criar conta com email + senha. Retorna {ok} ou {erro}. */
async function netSignUp(email, senha){
  const { data, error } = await sb.auth.signUp({ email:email.trim(), password:senha });
  if(error) return { erro: error.message };
  MEU_UID = data.user ? data.user.id : (data.session && data.session.user.id) || null;
  if(!MEU_UID){ return { erro:'Conta criada, mas sem sessão. Confirme se o "Confirm email" está desligado no Supabase.' }; }
  return { ok:true };
}

/* Entrar com email + senha (quem já tem conta). */
async function netLogin(email, senha){
  const { data, error } = await sb.auth.signInWithPassword({ email:email.trim(), password:senha });
  if(error) return { erro: error.message };
  MEU_UID = data.user.id;
  return { ok:true };
}
async function netLogout(){ await sb.auth.signOut(); }
window.netSignUp = netSignUp; window.netLogin = netLogin; window.netLogout = netLogout;

/* 2. Espelhar o jogador local no banco. Chamar depois do cadastro e a cada
      mudança relevante (nível, cosmético). É upsert: cria ou atualiza. */
async function netSyncJogador(eu){
  if(!MEU_UID) return;
  const row = {
    id: MEU_UID,
    nome: eu.nome, ap: eu.ap ?? null, email: eu.email ?? null,
    clube: eu.clube ?? null,
    /* 16/08: estas quatro viajam por compatibilidade, mas o banco DESCARTA
       (mig 31): quem move o Nível agora é o servidor, na confirmação da
       partida. Continuam aqui porque tirá-las não muda nada e mexer no upsert
       sem necessidade é risco de graça — saem junto com a limpeza que faz o
       cliente hidratar em vez de somar. */
    nivel: eu.nivel ?? 1200, nivelb: eu.nivelB ?? 1200,
    calibrando: !!eu.calibrando, cal: eu.cal ?? 0,
    /* 16/08: o carimbo de versão (mig 32). É o que permite MEDIR quantas contas
       ainda rodam cliente velho — e sem essa medida a Entrega 4 (o servidor
       RECUSAR em vez de sobrescrever) não pode começar, porque recusar escrita
       de cliente que ainda está no ar é o app fora do ar pra quem não tocou na
       tarja. `VERSAO` é global de index.html e só existe depois do boot; o
       typeof evita que um sync muito cedo mande `undefined` e derrube o upsert. */
    app_versao: (typeof VERSAO === 'number' && VERSAO) ? VERSAO : null,
    bon: eu.bon ?? null, roupa: eu.roupa ?? null, cor: eu.cor ?? null,
    cena: eu.cena ?? null, escudo: eu.escudo ?? null,
    patroc: eu.patroc ?? null, vestiario: eu.vestiario ?? null,
    // 11/08: idade. Vai como `undefined` (e some do upsert) quando não houver
    // — as contas criadas antes da migração 15 não têm declaração, e inventar
    // uma retroativa seria registrar como fato algo que ninguém perguntou.
    ...(eu.nascimento ? {
      nascimento: eu.nascimento,
      maior_de_18: !!eu.maiorDe18,
      idade_declarada_em: eu.idadeDeclaradaEm ?? null,
    } : {}),
    // 25/08 (telas novas, mig 54): mão dominante e tempo de prática. Mesmo
    // padrão do nascimento — só viajam quando existem, então conta antiga
    // não manda undefined nem quebra contra banco sem a migração.
    ...(eu.mao ? { mao: eu.mao } : {}),
    ...(eu.tempoPratica ? { tempo_pratica: eu.tempoPratica } : {}),
    // 25/08 (mig 62): o canal de contato preferido
    ...(eu.contatoCanal ? { contato_canal: eu.contatoCanal } : {}),
    ...(eu.contatoValor ? { contato_valor: eu.contatoValor } : {}),
    // 25/08 (mig 66): a porta pela qual entrou e se compete. Mesmo padrão
    // condicional: conta antiga não manda undefined nem quebra contra banco
    // sem a migração.
    ...(eu.perfil ? { perfil: eu.perfil } : {}),
    ...(eu.joga !== undefined ? { joga: !!eu.joga } : {}),
  };
  const { error } = await sb.from('players').upsert(row);
  if(error){ console.error('[net] sync falhou', error); throw error; }
}

/* 3. Adversários reais: todo mundo no banco menos eu. Vira a lista do
      "escolher adversário" da partida online. */
async function netAdversarios(){
  if(!MEU_UID) return [];
  /* 18/08 (mig 41 e 42): `banido_em` e `livre_ate` viajam junto. O elenco
     NÃO filtra banido de propósito — o inbox precisa do nome dele pra desenhar
     a partida em aberto, e `_nomeDe` lê daqui. Quem esconde é o RADAR e a
     BUSCA, que são as duas superfícies onde aparecer = ser oferecido. */
  /* 18/08: `escudo` e `patroc` entram. Existem em `players` desde o schema e
     nunca foram lidos daqui — o boneco do adversário sempre renderizou sem
     marca, e a camisa patrocinada era vista por UMA pessoa: quem a veste.
     Enquanto isso valesse, qualquer número de alcance prometido a um
     patrocinador seria falso. São escolhas de exibição, públicas por natureza
     (estão na camisa), e `players_select` é `using(true)`. */
  const { data, error } = await sb.from('players')
    .select('id, nome, ap, nivel, nivelb, bon, cor, banido_em, livre_ate, escudo, patroc, perfil, joga')
    .neq('id', MEU_UID)
    .order('nome');
  if(error){ console.error('[net] lista falhou', error); return []; }
  return data;
}
/* os dois predicados que radar e busca aplicam. Ficam aqui, nomeados, pra que
   uma terceira superfície um dia use os mesmos em vez de reinventar. */
const _banido = (p)=> !!(p && p.banido_em);
const _livreAgora = (p)=> !!(p && p.livre_ate && new Date(p.livre_ate) > new Date());
window._banido = _banido; window._livreAgora = _livreAgora;

/* 18/08 (mig 42): liga/desliga "tô livre hoje". Manda o FIM DO DIA e deixa o
   banco recortar — o trigger `players_b_livre` limita ao fim de hoje em Salvador
   de qualquer jeito, então mandar 23:59:59 local é só o app dizendo o que ele
   quer, não o que vai valer. `null` desliga.
   `.select('livre_ate')` traz o que FICOU, não o que foi mandado: é o valor
   recortado pelo trigger que vai pro elenco local, senão a tela mostraria o
   pedido em vez do fato. */
async function netLivreHoje(ligar){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  let valor = null;
  if(ligar){ const f = new Date(); f.setHours(23,59,59,0); valor = f.toISOString(); }
  const { data, error } = await sb.from('players')
    .update({ livre_ate: valor }).eq('id', MEU_UID).select('livre_ate').single();
  if(error){ alert('Não deu pra mudar: '+error.message); return; }
  if(typeof S!=='undefined' && S.jogadores && S.jogadores[EU]){
    S.jogadores[EU].livreAte = data ? data.livre_ate : null;
    if(window.salvar) salvar();
    if(window.render) render();
  }
  if(window.toast) toast(ligar ? '🎾 Você está no topo do radar até meia-noite.' : 'Desligado.');
}
window.netLivreHoje = netLivreHoje;

/* Badge de status no canto — o Nuno valida vendo. Verde = conectou e sincronizou. */
function netBadge(estado, txt){
  let el = document.getElementById('net-badge');
  if(!el){
    el = document.createElement('div');
    el.id = 'net-badge';
    el.style.cssText = 'position:fixed;top:5px;left:5px;z-index:9999;width:8px;height:8px;'
      + 'border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,.35);pointer-events:none;transition:background .3s;opacity:.85';
    document.body.appendChild(el);
  }
  const cor = { conectando:'var(--gold)', on:'var(--up)', off:'var(--dn)' }[estado] || '#555';
  el.style.background = cor;
  el.title = txt;   // pontinho discreto; o texto vive no tooltip
}

/* Boot da conexão. Não bloqueia o app: se o Supabase cair, o protótipo roda
   igual (offline), só sem o online. Recebe o jogador local pra espelhar. */
async function netBoot(eu){
  try{
    netBadge('conectando', 'conectando…');
    const uid = await netEntrar();
    if(!uid){                                  // sem login → abre a tela de entrar/criar conta
      netBadge('off', 'entre');
      if(window.abrirCadastro && !(typeof onb!=='undefined' && onb)) abrirCadastro();
      return null;
    }
    netBadge('on', 'conectado · ' + uid.slice(0,8));
    // CONTA: busca meu jogador no banco. Se já existe (conta real), HIDRATA o
    // app a partir dele e pula o cadastro — em qualquer aparelho. Só sobe o
    // local quando é a primeira vez (não sobrescreve conta real com o default).
    const { data: meuRow } = await sb.from('players').select('*').eq('id',uid).maybeSingle();
    /* 18/08 (mig 41): CONTA BANIDA PARA AQUI. Antes de hidratar, antes de
       carregar elenco, antes de ligar o tempo-real. A coluna existe pra isso;
       sem esta linha, banir seria escrever num campo que ninguém lê — o
       `matches.cantada` da moderação. A tela é própria e sem fechar clicando
       fora, pelo mesmo motivo da declaração de idade: não é opcional. */
    if(meuRow && meuRow.banido_em){
      netBadge('off', 'conta suspensa');
      netTelaBanido(meuRow);
      return null;
    }
    const contaReal = meuRow && meuRow.nome && meuRow.nome!=='Você';
    if(contaReal && window.hidratarJogador){ window.hidratarJogador(meuRow); }
    // 11/08: conta anterior à migração 15 não tem declaração de idade nenhuma —
    // e inventar uma retroativa seria registrar o que ninguém perguntou. A
    // pergunta é feita AGORA, uma vez, no login: é o registro que faltaria se
    // alguém cobrasse.
    if(contaReal && !meuRow.nascimento){ try{ netPedirIdade(); }catch(e){} }
    else if(S.cadastroFeito && S.jogadores[EU].nome!=='Você'){ await netSyncJogador(S.jogadores[EU]); }
    // se não há conta real em lugar nenhum e o cadastro não foi feito, abre o cadastro
    if(!contaReal && !S.cadastroFeito && window.abrirCadastro){ abrirCadastro(); }
    // carrega os jogadores REAIS do banco e injeta no app (sem elenco fake).
    try{
      const outros = await netAdversarios();
      if(window.aplicarJogadoresReais){ window.aplicarJogadoresReais(outros); if(window.render) render(); }
    }catch(e){ console.error('[net] carregar jogadores falhou', e); }
    try{ await netCarregarAmigos(); }catch(e){}
    /* localização (migração 19): locais + os meus + o mapa do radar. O espelho
       em window é o que as telas síncronas leem (ficha, quadro, radar).

       18/08 — SUBIU PRA CÁ, e a ordem é o conserto. Isto rodava DEPOIS do
       inbox, e o card do desafio desenha o local lendo `_locDe()`, que lê este
       cache. Com o cache ainda nulo, `_pinDe` não achava a linha e a apagava
       inteira: clube, quadra e endereço sumiam do card sem erro nenhum — e o
       inbox é justamente a tela que ABRE sozinha quando chega desafio. Quem
       recebia via só a data e quem leva a bola, e o combinado do lugar parecia
       nunca ter sido enviado. Carregar antes custa uma consulta na frente do
       inbox; não carregar custa a informação principal do card. */
    try{ await netLocais(); await netMeusLocais(); await netMapaLocais(); }catch(e){}
    // liga o tempo-real e carrega as partidas em aberto (desafios, placares pra confirmar)
    netSubscribe();
    await netAtualizarInbox();
    try{ await netEntrarPorLink(); }catch(e){ console.error('[net] entrar por link', e); }
    // virada da temporada: apura troféus e abre a próxima, se a atual venceu
    try{ await netFecharTemporada(); }catch(e){}
    // sou ADM do app? acende a porta de entrada da aba ADM (migração 18)
    try{ await netCheckAdm(); }catch(e){}
    try{ await netCheckPerfil(); }catch(e){}   // (66) o papel decide a nav e a home
    // as comunidades reais e minha posição em cada uma (12/08) — mesmo padrão
    try{ await netMeusQuadros(); }catch(e){}
    // destaque por movimento na comunidade (12/08)
    try{ await netDestaques(); }catch(e){}
    console.log('[net] conectado como', uid, '— jogador + partidas carregados');
    return uid;
  }catch(e){
    netBadge('off', 'offline');
    console.error('[net] boot falhou:', e);
    return null;
  }
}

/* =========================================================================
   INCREMENTO 2 — o handshake do ciclo. Dois apertos de mão:
     2a  DESAFIO: A desafia B → B aceita/recusa (status desafiado→aceito)
     2b  PLACAR:  depois de aceito, alguém lança o placar → o outro confirma
                  (status aceito→pendente→confirmada) e o Nível mexe nos dois.
   Tudo ao vivo via Realtime do Supabase. Motor de cálculo continua no cliente.
   ========================================================================= */

// helpers de perspectiva
const _souCriador = (m)=> m.criador_id === MEU_UID;
const _advId = (m)=> _souCriador(m) ? m.adversario_id : m.criador_id;   // o "outro"
const _chaveLocal = (uid)=> (uid===MEU_UID) ? EU : uid;                 // uid → chave em S.jogadores
const _nomeDe = (uid)=>{ const j = S.jogadores[_chaveLocal(uid)]; return (j&&j.nome) || 'Jogador'; };

/* 18/08: o avatar das listas do net.js eram SEIS cópias do mesmo <div> inline —
   e quatro delas desenhavam só o disco colorido, sem as iniciais dentro. Disco
   mudo em lista de 28px não identifica ninguém: numa comunidade com dois
   jogadores de cor parecida, as duas linhas viram a mesma linha.

   Não usa o `avatar()` do index de propósito. Aquele é o boneco de corpo
   inteiro, desenhado em canvas e pensado pra 96px pra cima; aqui são listas de
   28 a 36px, onde ele vira borrão e cobra render caro por linha. O disco com
   inicial é a versão honesta desse tamanho.

   `ap` vem do cadastro, ou seja, é texto de gente — escapa sempre. */
const _disco = (o, px=28)=>{
  const cor = (o && o.cor) || '#5C2E3C';
  const ini = _admEsc((o && o.ap) || '?');
  return `<div style="width:${px}px;height:${px}px;border-radius:50%;background:${cor};flex:0 0 ${px}px;`
       + `display:flex;align-items:center;justify-content:center;color:#FFFEFD;`
       + `font:700 ${Math.max(10, Math.round(px*0.36))}px system-ui">${ini}</div>`;
};
const _discoUid = (uid, px=28)=> _disco(S.jogadores[_chaveLocal(uid)], px);
const _inverter = (placar)=> (placar||'').split(/\s+/).map(p=>{ const m=p.match(/^(\d+)\D+(\d+)$/); return m?`${m[2]}-${m[1]}`:p; }).join(' ');

/* ---- Identidade pública + amigos -------------------------------------- */
// ID público estável, derivado do uid (aparece no perfil e serve pra busca).
const netId = (uid)=> '#' + String(uid||'').replace(/-/g,'').slice(0,6).toUpperCase();
window.netId = netId;

function _meusAmigos(){ const eu=S.jogadores[EU]; if(!eu.amigos) eu.amigos=[]; return eu.amigos; }
const netEhAmigo = (uid)=> _meusAmigos().includes(uid);
window.netEhAmigo = netEhAmigo;

/* 11/08: a amizade era um array na MINHA linha, então era mão única por
   construção — a RLS só me deixa escrever em mim, e eu nunca tive como me pôr
   na lista do outro. Agora é uma linha por par, na tabela `amizades`, com
   `a < b` garantindo ordem canônica: o mesmo par não gera duas linhas nem
   depende de quem chegou primeiro.
   O par ordenado é calculado aqui e no banco do mesmo jeito — se divergirem,
   a chave primária rejeita, que é o lugar certo pra descobrir. */
const _par = (x, y)=> (x < y ? [x, y] : [y, x]);

// carrega meus amigos do banco pro estado local (chamado no boot)
async function netCarregarAmigos(){
  if(!MEU_UID) return;
  const { data, error } = await sb.from('amizades').select('a,b')
    .or(`a.eq.${MEU_UID},b.eq.${MEU_UID}`);
  if(error){ console.error('[net] carregar amigos', error); return; }
  // o amigo é o outro lado do par, qualquer que seja a coluna em que ele caiu
  S.jogadores[EU].amigos = (data||[]).map(r=> r.a === MEU_UID ? r.b : r.a);
  salvar();
}

/* 13/08 — AMIZADE DEIXOU DE NASCER DE UM LADO SÓ.
   Antes isto era um upsert direto em `amizades`, e o `or` da policy antiga
   (`auth.uid() = a or auth.uid() = b`) deixava eu virar seu amigo sem você
   tocar em nada. Não era cosmético: amigo se desafia em QUALQUER classe, e a
   `patch_envios_ins` usa a amizade como porteiro de quem recebe patch —
   prometendo no comentário uma mutualidade que não existia.
   Agora vira pedido, e quem fecha é quem RECEBE (migração 25).

   `upsert` e não `insert`: a PK é (de,para) e 'recusado' é linha viva, não
   linha apagada. Reabrir um pedido é voltar pra 'pendente', e a policy
   `amizade_pedidos_reabrir` permite exatamente essa transição. */
/* `nome` vem da busca de propósito: `_nomeDe` só enxerga quem já está em
   `S.jogadores` (adversário ou amigo), e quem acabou de ser achado na busca
   ainda não está — o toast saía "Vocês viram amigos quando Jogador aceitar".
   Mesma razão do `desafiarUid`, que já carregava o nome no onclick. */
async function netPedirAmizade(uid, nome){
  if(!MEU_UID || uid === MEU_UID) return;
  const primeiro = ((nome||'').trim() || _nomeDe(uid)).split(' ')[0];
  /* 13/08 — o segundo clique morria. O pedido já existia como (de,para)
     'pendente', então o upsert virava UPDATE pendente→pendente, e NENHUMA das
     duas policies de update cobre essa transição: `recusar` exige ser o `para`,
     `reabrir` exige estado 'recusado'. Vinha 42501 e a tela dizia "não deu pra
     enviar" sobre um pedido que estava enviado desde o primeiro clique.
     O caminho certo é nem ir ao banco: pedido pendente é estado conhecido. */
  if(netJaPedi(uid)){
    if(window.toast) toast('Você já pediu — falta <b>' + primeiro + '</b> aceitar.');
    return;
  }
  const { error } = await sb.from('amizade_pedidos')
    .upsert({ de: MEU_UID, para: uid, estado: 'pendente' }, { onConflict: 'de,para' });
  if(error){
    console.error('[net] pedir amizade', error);
    if(window.toast) toast('Não deu pra enviar o pedido agora. Tente de novo.');
    return;                      // não mexe no estado local se o banco recusou
  }
  /* NÃO entra em `_meusAmigos()`: a amizade não existe ainda, e escrever aqui
     faria a tela afirmar o que não aconteceu — a mesma armadilha do toast que
     confirma o que não persistiu. Mas o PEDIDO existe, e a lista dele é o que
     faz o botão virar "pedido enviado" em vez de continuar oferecendo o que já
     foi feito. Escrever sem superfície de leitura é o que quebrou aqui. */
  if(_pedidosEnviados && !_pedidosEnviados.includes(uid)) _pedidosEnviados.push(uid);
  else if(!_pedidosEnviados) _pedidosEnviados = [uid];
  if(window.render) render();
  if(window.netRenderBusca) netRenderBusca();
  if(window.toast) toast('Pedido enviado. Vocês viram amigos quando <b>' + primeiro + '</b> aceitar.');
}

/* Os pedidos que EU mandei. `netCarregarPedidosAmizade` só trazia os recebidos
   (`para = eu`), então a busca não tinha como saber que o pedido já saiu — e
   oferecia "Pedir amizade" pra quem já tinha sido pedido. */
let _pedidosEnviados = null;
async function netCarregarPedidosEnviados(force){
  if(_pedidosEnviados && !force) return _pedidosEnviados;
  if(!MEU_UID) return [];
  const { data, error } = await sb.from('amizade_pedidos')
    .select('para').eq('de', MEU_UID).eq('estado','pendente');
  if(error){ console.error('[net] pedidos enviados', error); _pedidosEnviados = null; return []; }
  _pedidosEnviados = (data||[]).map(r=>r.para);
  return _pedidosEnviados;
}
const netJaPedi = (uid)=> (_pedidosEnviados||[]).includes(uid);
window.netCarregarPedidosEnviados = netCarregarPedidosEnviados;
window.netJaPedi = netJaPedi;
window.netPedirAmizade = netPedirAmizade;
/* o nome antigo continua ligado: `_net.addAmigo` está chumbado no onclick do
   botão da busca, e trocar rótulo sem trocar a chave falha em silêncio */
const netAddAmigo = netPedirAmizade;
window.netAddAmigo = netPedirAmizade;

/* Aceitar é duas escritas sem transação. A ordem importa: fecha a amizade
   PRIMEIRO e apaga o pedido depois — se falhar no meio, sobra pedido órfão
   (inofensivo, some no próximo aceite) em vez de pedido apagado sem amizade
   (que deixaria os dois sem caminho de volta). */
async function netAceitarAmizade(uid){
  if(!MEU_UID || uid === MEU_UID) return;
  const [a, b] = _par(MEU_UID, uid);
  const { error } = await sb.from('amizades')
    .upsert({ a, b, criada_por: MEU_UID }, { onConflict: 'a,b', ignoreDuplicates: true });
  if(error){
    console.error('[net] aceitar amizade', error);
    if(window.toast) toast('Não deu pra aceitar agora. Tente de novo.');
    return;
  }
  await sb.from('amizade_pedidos').delete().eq('de', uid).eq('para', MEU_UID);
  const meus=_meusAmigos(); if(!meus.includes(uid)){ meus.push(uid); salvar(); }
  try{ await netCarregarPedidosAmizade(true); }catch(e){}
  if(window.render) render();
  if(window.toast) toast('Amigos. Agora <b>os dois</b> podem se desafiar em qualquer classe.');
}
window.netAceitarAmizade = netAceitarAmizade;

async function netRecusarAmizade(uid){
  if(!MEU_UID) return;
  const { error } = await sb.from('amizade_pedidos')
    .update({ estado: 'recusado' }).eq('de', uid).eq('para', MEU_UID);
  if(error){ console.error('[net] recusar amizade', error); return; }
  try{ await netCarregarPedidosAmizade(true); }catch(e){}
  if(window.render) render();
}
window.netRecusarAmizade = netRecusarAmizade;

/* Os pedidos que ESPERAM a minha resposta. Só os pendentes: 'recusado' é
   registro, não caixa de entrada. */
let _pedidosAmizade = null;
async function netCarregarPedidosAmizade(force){
  if(_pedidosAmizade && !force) return _pedidosAmizade;
  if(!MEU_UID) return [];
  const { data, error } = await sb.from('amizade_pedidos')
    .select('de,criado_em').eq('para', MEU_UID).eq('estado','pendente');
  if(error){ console.error('[net] pedidos de amizade', error); _pedidosAmizade = null; return []; }
  _pedidosAmizade = data || [];
  return _pedidosAmizade;
}
window.netCarregarPedidosAmizade = netCarregarPedidosAmizade;
window.netPedidosAmizade = ()=> _pedidosAmizade || [];

// busca por nome, email ou ID (prefixo hex do uid). Client-side (base pequena).
async function netBuscar(termo){
  termo=(termo||'').trim().toLowerCase();
  if(!termo) return [];
  const { data } = await sb.from('players').select('id,nome,ap,email,nivel,nivelb,nivel_duplas,nivelb_duplas,bon,cor,banido_em,perfil,joga').neq('id',MEU_UID);
  const idHex = termo.replace(/[^a-f0-9]/g,'');
  // 18/08 (mig 41): banido não é achável. Nem por ID exato — buscar é o
  // caminho pra pedir amizade e desafiar, e nenhum dos dois pode chegar nele.
  return (data||[]).filter(p=> !_banido(p)).filter(p=>
    (p.nome||'').toLowerCase().includes(termo) ||
    (p.email||'').toLowerCase().includes(termo) ||
    (idHex.length>=2 && p.id.replace(/-/g,'').toLowerCase().startsWith(idHex))
  );
}
window.netBuscar = netBuscar;

// parse "6-3 6-4" → [[6,3],[6,4]] (meus games primeiro). null se vazio.
function netParsePlacar(txt){
  const sets = (txt||'').trim().split(/\s+/).map(p=>{
    const m = p.match(/^(\d+)\D+(\d+)$/); return m ? [ +m[1], +m[2] ] : null;
  }).filter(Boolean);
  return sets.length ? sets : null;
}

/* ---- Realtime + caixa de partidas ------------------------------------- */
let _canal = null;
let _inbox = [];
/* 26/08: a query do inbox já pede `select('*')` com 'confirmada' e sem limite —
   e o filtro lá embaixo jogava o resto fora. Guardar o array inteiro custa ZERO
   consulta e é o que destrava os selos da Sala de Conquistas: `zebra` (dentro do
   jsonb do delta), `placar_em`, `placar_por`, `confirmed_at` e
   `fechada_por_prazo` só existem aqui — o `S.historico` é do APARELHO e nasce
   vazio em celular novo. */
let _todasMinhas = [];
const _expirando = {};   // guarda de reentrada do vencimento do cinturão
let _inboxStatus = {};   // matchId → última chave de estado vista (ver _chaveEstado)

function netSubscribe(){
  if(_canal || !MEU_UID) return;
  _canal = sb.channel('matches-'+MEU_UID)
    .on('postgres_changes', { event:'*', schema:'public', table:'matches' }, ()=> netAtualizarInbox())
    .subscribe();
}

/* ---- A LADDER DE DUPLAS NO APP (mig 46) --------------------------------
   Trilho próprio: partida de duplas lê e move `nivel_duplas`/`nivelb_duplas`,
   nunca o Nível de simples — duplas não tem divisão e não afeta promoção nem
   rebaixamento (31/07). A ladder foi SEMEADA com o simples na migração, então
   o `?? nivel` é só a rede pra linha que chegou por caminho que não passou
   pelo trigger; em campo os dois já vêm preenchidos.

   `_motorTime` é o espelho EXATO do `_motor_time` do banco (mig 46): média
   dos dois com floor(x+0,5). Se as duas contas divergirem, a prévia mente — e
   prévia que mente é pior que prévia nenhuma, porque é com ela que a pessoa
   decide se aceita o jogo. */
const _ladderDe = (j)=> !j ? 1200
  : ((typeof S!=='undefined' && S.esporte==='beach')
      ? (j.nivelb_duplas ?? j.nivelb ?? j.nivelB ?? 1200)
      : (j.nivel_duplas  ?? j.nivel  ?? 1200));
const _motorTime = (a,b)=> Math.floor((a+b)/2 + 0.5);

/* Os quatro assentos, e onde EU sento. null em partida de simples pra quem
   não está nela — quem chama separa os dois mundos sem repetir a pergunta. */
function _assentoDe(m, uid){
  uid = uid || MEU_UID;
  if(!m) return null;
  if(m.criador_id===uid)             return 'criador';
  if(m.adversario_id===uid)          return 'adversario';
  if(m.parceiro_criador_id===uid)    return 'parceiro_criador';
  if(m.parceiro_adversario_id===uid) return 'parceiro_adversario';
  return null;
}
const _souCapitao = (m,uid)=> ['criador','adversario'].includes(_assentoDe(m,uid));
/* O aceite que EU ainda devo nesta partida. null quando não se aplica. */
function _meuAceitePendente(m){
  if(!m || !m.dupla || m.status!=='desafiado') return null;
  if(m.parceiro_criador_id===MEU_UID    && !m.aceite_parceiro_criador)    return 'aceite_parceiro_criador';
  if(m.parceiro_adversario_id===MEU_UID && !m.aceite_parceiro_adversario) return 'aceite_parceiro_adversario';
  return null;
}
window._netDuplas = { ladderDe:_ladderDe, motorTime:_motorTime, assentoDe:_assentoDe,
                      souCapitao:_souCapitao, meuAceitePendente:_meuAceitePendente };

// precisa da MINHA ação?  (desafio pra mim · aceito sem placar · placar pra confirmar)
function netAcionavel(m){
  /* (45/47) O PARCEIRO tem UMA ação, e é a que trava os outros três: enquanto
     os dois carimbos não existem, o capitão adversário não consegue aceitar
     (trava 17 do guard). Convite que não acende o ✉ morre igual aos troféus do
     ADM — objeto emitido sem superfície de leitura. */
  if(_meuAceitePendente(m)) return true;
  /* Parceiro que já carimbou não tem mais nada a fazer: ele não lança placar
     nem confirma (trava 19). O card fica na caixa como acompanhamento, sem
     badge — badge que acende pra quem não pode agir ensina a ignorar badge. */
  if(m.dupla && !_souCapitao(m)) return false;
  if(m.status==='desafiado') return m.prop_por ? m.prop_por!==MEU_UID
                                               : m.adversario_id===MEU_UID;
  if(m.status==='aceito')    return true;                    // qualquer um dos dois lança
  if(m.status==='pendente')  return m.placar_por !== MEU_UID; // o outro confirma
  /* CONTESTADA pede ação dos DOIS (20/08): a partida está parada até alguém
     relançar, e qualquer um dos dois pode. Sem acender o ✉, ela seria uma
     pendência que ninguém lembra que existe — que é como ela ficou presa antes
     de ter card. */
  if(m.status==='contestada') return true;
  return false;
}
/* O que conta como "novidade que exige a minha ação". Era só `m.status`, e a
   contraproposta NÃO muda o status (segue 'desafiado') — então ela nunca era
   vista como transição nova, nem pra quem tinha a vez. A rodada entra na chave
   porque cada ida e volta é um aviso diferente: proposta 2 chegando por cima da
   1 tem que acender de novo. */
const _chaveEstado = (m)=> (m.status==='desafiado' && m.prop_por)
  ? `desafiado:prop${m.prop_rodadas||0}:${m.prop_por}`
  : m.status;

async function netAtualizarInbox(){
  if(!MEU_UID) return;
  /* (45) OS QUATRO ASSENTOS. Sem as duas linhas de parceiro aqui, o convite de
     duplas nunca chega em tela nenhuma: a `matches_select` já libera a leitura
     pros quatro, mas quem não é pedido não é lido. É o par que faltava — a
     fechadura abriu na 45, a porta é esta. */
  const { data, error } = await sb.from('matches').select('*')
    .or(`criador_id.eq.${MEU_UID},adversario_id.eq.${MEU_UID},`
      + `parceiro_criador_id.eq.${MEU_UID},parceiro_adversario_id.eq.${MEU_UID}`)
    /* 'contestada' ENTRA AQUI (20/08). Sem ela, contestar era um beco sem
       saída: o `netContestar` gravava o status, a partida saía desta consulta
       e SUMIA pros dois — sem card, sem caminho de relançar, presa pra sempre.
       O toast dizia "conversem e lancem de novo" e não havia onde.
       O banco sempre permitiu a volta (nenhuma das 19 travas do guard barra
       `contestada → pendente`, e o placar só congela em 'confirmada') — quem
       fechava a porta era esta linha. */
    .in('status',['desafiado','aceito','pendente','confirmada','contestada'])
    .order('created_at',{ascending:false});
  if(error){ console.error('[net] inbox', error); return; }
  // 11/08: apura o prazo de 72h ANTES de ler o resto. Se fechou alguma, a
  // lista em mãos envelheceu na hora — recarrega em vez de renderizar dado
  // morto. Não recursa infinito: partida fechada sai de 'pendente' e o
  // `_prazoVencido` para de vê-la na segunda passada.
  if(await netApurarPrazos(data)) return netAtualizarInbox();
  // 16/08: o W.O. vem depois do prazo e pela mesma razão — se encerrou alguma,
  // a lista em mãos envelheceu e renderizar dado morto é pior que recarregar.
  if(await netApurarWO(data))     return netAtualizarInbox();
  // se apareceu alguém que ainda não está no meu elenco (desafiou recém-cadastrado),
  // recarrega os jogadores pra o nome aparecer certo em vez de "Jogador".
  const desconhecido = data.some(m=> !S.jogadores[_chaveLocal(_advId(m))]);
  if(desconhecido && window.aplicarJogadoresReais){
    try{ window.aplicarJogadoresReais(await netAdversarios()); }catch(e){}
  }
  /* 18/08: mesma ideia pro LUGAR. Subir o `netLocais` no boot resolve a corrida
     da abertura, mas não o clube cadastrado pelo ADM depois que eu conectei —
     esse chega no card por tempo-real com um `local_id` que o meu cache não
     conhece, e `_pinDe` apagaria a linha em silêncio de novo.

     O `_locTentados` não é zelo: `netLocais` filtra `ativo=true`, então local
     DESATIVADO pelo ADM nunca vai ser achado por mais que se recarregue — e sem
     a marca, toda atualização do inbox dispararia a consulta outra vez, pra
     sempre. Tenta uma vez por id e desiste; o `_pinDe` diz o que sobrou. */
  const naoAchados = data.map(m=>m.local_id).filter(id=> id && !_locDe(id) && !_locTentados.has(id));
  if(naoAchados.length || !_locais){
    naoAchados.forEach(id=> _locTentados.add(id));
    try{ await netLocais(true); }catch(e){ console.error('[net] locais no inbox', e); }
  }
  netAplicarConfirmadas(data);                 // mexe no meu nível se fechou partida
  let abrirInbox=false, desafioVS=null;
  data.forEach(m=>{
    const chave=_chaveEstado(m);
    const prev=_inboxStatus[m.id];
    if(netAcionavel(m) && prev!==chave){             // transição nova que exige ação
      // só o desafio CRU vai pra tela VS; contraproposta é conversa sobre um
      // desafio que já existe, e a tela VS o apresentaria como se fosse novo
      if(m.status==='desafiado' && m.adversario_id===MEU_UID && !m.prop_por) desafioVS=m;
      else abrirInbox=true;                                                   // resto → caixa
    }
    _inboxStatus[m.id]=chave;
  });
  // 'cancelado' entra aqui junto de 'recusado' por defesa em profundidade: a
  // query acima já não pede esse status, mas quem mexer nela um dia não vai
  // lembrar deste filtro — e partida cancelada na caixa é card zumbi.
  _todasMinhas = data || [];
  window.__minhasPartidas = _todasMinhas;   // espelho: render da sala é síncrono
  _inbox = data.filter(m=> m.status!=='confirmada' && m.status!=='recusado' && m.status!=='cancelado');
  /* 13/08: pedido de amizade também pede a minha ação, então entra na mesma
     conta. Sem isto o pedido chega e o ✉ não acende — e ninguém abre uma caixa
     que não avisa que tem coisa dentro. */
  try{ await netCarregarPedidosAmizade(true); }catch(e){}
  // badge do ✉ na home = quantas coisas pedem a minha ação
  if(typeof S!=='undefined'){
    S.novidades = _inbox.filter(netAcionavel).length + (window.netPedidosAmizade ? netPedidosAmizade().length : 0);
    if(window.render) render();
  }
  if(desafioVS && window.mostrarDesafioVS) window.mostrarDesafioVS(desafioVS);
  else if(abrirInbox) netAbrirInbox();
  else if(document.getElementById('net-inbox')) netRenderInbox();
  // batida das salas (mig 51): sem await — recado não segura a caixa
  netAvisos();
}

/* Aplica no MEU nível o delta de partidas confirmadas que ainda não apliquei.
   Cada aparelho aplica só o SEU delta, uma única vez (guardado em S.deltasAplicados),
   então funciona mesmo se eu estava offline quando o outro confirmou. */
function netAplicarConfirmadas(list){
  if(!S.deltasAplicados) S.deltasAplicados=[];
  let mexeu=false;
  /* 12/08 (b): a posição TEM que ser lida antes de qualquer delta entrar —
     depois já é a de chegada, e o painel mostraria "2º → 2º" pra quem subiu. */
  let posAntes=null; try{ posAntes = posicoes(); }catch(e){}
  let ultima=null;                       // a partida que vai abrir o painel
  (list||[]).forEach(m=>{
    if(m.status!=='confirmada') return;
    if(!m.delta_criador || !m.delta_adversario) return;
    if(S.deltasAplicados.includes(m.id)) return;
    /* (46) EM DUPLAS O DELTA É POR ASSENTO, e o trilho é OUTRO. O parceiro
       recebe o delta do LADO (o banco grava os quatro), e o número que anda é
       a ladder — nunca o Nível de simples, nunca a calibragem. Espelha o ramo
       de duplas do `_matches_creditar_nivel`; se este espelho divergir, o app
       mostra um número que o banco não tem. */
    const eu = S.jogadores[EU];
    if(m.dupla){
      const assento = _assentoDe(m);
      if(!assento) return;                       // não é minha partida
      const meuD = (assento==='criador'   || assento==='parceiro_criador')
                     ? m.delta_criador : m.delta_adversario;
      if(!meuD) return;
      if(m.esporte==='beach') eu.nivelb_duplas = (eu.nivelb_duplas??1200) + (meuD.dNivel||0);
      else                    eu.nivel_duplas  = (eu.nivel_duplas ??1200) + (meuD.dNivel||0);
      // duplas NÃO anda cal nem calibrando (31/07) — a calibragem é do trilho
      // de cadastro, e o motor chama duplas com (false, 0)
      S.deltasAplicados.push(m.id); mexeu=true;
      const advCap = _nomeDe(m.criador_id===MEU_UID||m.parceiro_criador_id===MEU_UID
                              ? m.adversario_id : m.criador_id).split(' ')[0];
      if(window.toast) toast(`Duplas confirmada contra ${advCap} · Nível de duplas ${(meuD.dNivel>=0?'+':'')}${meuD.dNivel}`);
      return;
    }
    const meu = _souCriador(m) ? m.delta_criador : m.delta_adversario;
    if(m.esporte==='beach') eu.nivelB = (eu.nivelB??1200) + (meu.dNivel||0);
    else                    eu.nivel  = (eu.nivel ??1200) + (meu.dNivel||0);
    if(eu.calibrando){ eu.cal=(eu.cal||0)+1; if(eu.cal>=8) eu.calibrando=false; }
    // grava a partida no MEU histórico (na minha perspectiva) → aparece na ficha
    const euVenci = _souCriador(m) ? m.venceu_criador : !m.venceu_criador;
    const meuPlacar = _souCriador(m) ? m.placar : _inverter(m.placar);
    if(!S.historico) S.historico=[];
    // 11/08: `porPrazo` viaja junto com a partida. Sem ele o jogador vê meio
    // ponto na ficha e não tem como saber por quê — estado invisível vira bug
    // fantasma, e ele vai achar que o motor errou.
    /* 26/08: `zebra` vinha no delta e era descartado aqui — por isso o selo de
       Zebra tinha um `if(){}` vazio na sala com o comentário "sinal não guardado
       ainda". O sinal existe desde que o motor foi pro servidor. */
    S.historico.unshift({ adv:_advId(m), venceu:euVenci, placar:meuPlacar,
      dnivel:meu.dNivel||0, dpts:meu.dPts||0, quando:'agora',
      zebra: meu.zebra===true,
      porPrazo: !!m.fechada_por_prazo });
    S.deltasAplicados.push(m.id); mexeu=true;
    ultima = { m, meu, euVenci, meuPlacar };
    const nome0 = _nomeDe(_advId(m)).split(' ')[0];
    if(window.toast){
      /* 16/08: o texto dizia "em 72h" e virou mentira — com o carimbo, o prazo
         pode ter sido de 24h. O número exato não interessa a quem lê; o que
         interessa é que venceu e o placar fechou sozinho. */
      toast(m.fechada_por_prazo
        ? `${nome0} não confirmou no prazo — o placar fechou sozinho valendo <b>metade</b> · Nível ${(meu.dNivel>=0?'+':'')}${meu.dNivel}`
        : `Partida com ${nome0} confirmada · Nível ${(meu.dNivel>=0?'+':'')}${meu.dNivel}`);
    }
  });
  if(mexeu){
    salvar(); if(window.render) render(); netSyncJogador(S.jogadores[EU]).catch(()=>{});
    netDestaques(true).catch(()=>{});   // a partida nova entra nos destaques
    /* A pontuação mudou, então a posição nas comunidades mudou junto: o espelho
       que o quadro lê precisa recarregar. Quem faz isso agora é o painel, com
       `await` lá dentro — ele DEPENDE do quadro atualizado. Sem partida pra
       mostrar (não deveria acontecer, mas é barato garantir), recarrega igual. */
    if(ultima && posAntes) _abrirOQueMexeu(ultima, posAntes);
    else netMeusQuadros(true).catch(()=>{});
  }
}

/* 12/08 (b) — O DERRAMAMENTO PRECISA APARECER NO FLUXO REAL.
   Até aqui a confirmação de verdade dava um toast e acabou: quem digitou o
   placar nunca via o que ele moveu — que é justamente o argumento pra topar
   digitar. A tela `mexeu` já existia e o `netQuadrosDaPartida` também; faltava
   o fio entre eles.

   POR QUE SAI DAQUI E NÃO DO `netConfirmar`
   `netAplicarConfirmadas` é o funil único por onde todo delta passa, dos DOIS
   lados: quem confirma vê na hora, e quem lançou o placar e estava offline vê
   quando abrir o app. Pendurar no `netConfirmar` deixaria metade das pessoas de
   fora. A trava de `S.deltasAplicados` já garante que roda uma vez só.

   POR QUE ESPERA O ESPELHO VOLTAR
   `posicoes()` lê o quadro que vem do servidor, e ele só chega depois do
   `netMeusQuadros`. Montar o painel antes mostraria "2º → 2º" pra quem acabou
   de subir — uma tela afirmando que nada mexeu, exatamente onde o produto
   promete que mexeu. Custa cerca de um segundo, e vale.

   A tela lê `posAntes.comunidade` e `posDepois.comunidade` SEM guarda: campo
   que falte aqui derruba a tela inteira, então todo o objeto é montado de uma
   vez, com padrão pra cada peça que pode faltar. */
async function _abrirOQueMexeu(ultima, posAntes){
  const { m, meu, euVenci, meuPlacar } = ultima;
  try{
    await netMeusQuadros(true);
    const posDepois = posicoes();
    const quadros   = await netQuadrosDaPartida(m.id);
    const eu = S.jogadores[EU];
    /* pelo esporte DA PARTIDA, não pelo que está aberto na tela: dá pra
       confirmar um placar de beach com o app mostrando tênis. */
    const nivelDepois = m.esporte==='beach' ? (eu.nivelB ?? 1200) : (eu.nivel ?? 1200);
    const dN = meu.dNivel || 0;
    const divDepois = divisaoDe(nivelDepois), divAntes = divisaoDe(nivelDepois - dN);
    /* 16/08 (histerese): o anúncio de subir/cair de classe só dispara ao
       cruzar a borda ±20 — a régua vive no `anunciarClasse` do index.html,
       compartilhada com o `aplicar()` local pra não existirem duas. */
    const hist = window.anunciarClasse
      ? anunciarClasse(eu, m.esporte==='beach', nivelDepois, divAntes)
      : { subiuDiv: divAntes!==divDepois && dN>0, caiuDiv: divAntes!==divDepois && dN<0 };
    S.ultimo = {
      adv: _chaveLocal(_advId(m)), venceu: euVenci, placar: meuPlacar,
      contexto: _ctxDoTorneio(await _torneioDe(m.torneio_id)),
      zebra: !!meu.zebra, dNivel: dN, dPts: meu.dPts || 0,
      nivel: nivelDepois, div: divDepois,
      posAntes, posDepois,
      subiuDiv: hist.subiuDiv,
      caiuDiv:  hist.caiuDiv,
      quadros, esporte: m.esporte || 'tenis',
    };
    salvar();
    if(document.querySelector('#onb.on')) return;   // não atropela quem está se cadastrando
    aba='inicio'; pilha=[{rota:'mexeu'}];
    if(window.render) render();
  }catch(e){ console.error('[net] painel do que mexeu', e); }
}

/* ---- 2a: desafiar ----------------------------------------------------- */
/* ---- 16/08: O PERFIL DO JOGADOR — tocar é consulta, não compromisso -------
   Até aqui, tocar no card do radar chamava `netDesafiar()` DIRETO: o toque
   mais natural da tela era o único que já assumia um compromisso. Não dava pra
   olhar quem é a pessoa antes de desafiar, e não havia lugar nenhum pra pedir
   amizade — a função existia desde 13/08 e não tinha porta.

   Agora o toque abre a ficha, e as duas ações moram DENTRO dela, com pesos
   diferentes: Desafiar é o botão cheio, Pedir amizade é o de contorno. A
   diferença importa porque as duas custam coisas diferentes — desafio marca
   um jogo, pedido de amizade abre o desafio fora da janela de ±1 classe.

   Pré-requisito do perfil público com URL própria, que é outra pendência. */
function netVerJogador(id){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const j = S.jogadores && S.jogadores[id];
  if(!j){ alert('Jogador não encontrado.'); return; }

  const eu    = S.jogadores[EU];
  const amigo = (eu.amigos||[]).includes(id);
  const advN  = (S.esporte==='beach') ? (j.nivelB ?? 1200) : (j.nivel ?? 1200);
  const v = calcular(nivelDe(eu), advN, true,  'amistoso','md3',false, eu.calibrando, eu.cal);
  const d = calcular(nivelDe(eu), advN, false, 'amistoso','md3',false, eu.calibrando, eu.cal);

  /* NÃO tem "onde ele joga" nesta ficha, e a ausência é deliberada. O dado
     existe em `player_locais`, mas o cliente não carrega o de terceiros — só o
     meu (`__meusLocais`). Botar a linha aqui exigiria uma consulta nova, e
     inventar um valor de fallback seria preencher com estatística um campo que
     existe pra ser fato. Fica de fora até ter fonte. */
  const primeiro = (j.nome||'').split(' ')[0] || 'ele';
  _sheet('net-perfil', `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Jogador</div>
      <button onclick="_net.fecharPerfil()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:14px">
      ${_disco(j, 52)}
      <div style="min-width:0">
        <b style="font-size:17px">${j.nome||'Jogador'}</b>
        <div style="font-size:12px;color:var(--ink2)">Classe ${divDe(j)} · Nível ${advN}${amigo?' · <span style="color:var(--up)">amigo</span>':''}</div>
      </div>
    </div>

    <div style="border:1px solid var(--linha);border-radius:12px;padding:12px;margin-top:14px">
      <div style="font:700 11px system-ui;color:var(--ink2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px">O que está em jogo</div>
      <div style="display:flex;gap:16px">
        <div><span style="font:700 17px system-ui;color:var(--up)">${v.dNivel>0?'+':''}${v.dNivel}</span>
          <span style="font-size:11px;color:var(--ink2)"> se vencer</span></div>
        <div><span style="font:700 17px system-ui;color:var(--dn)">${d.dNivel}</span>
          <span style="font-size:11px;color:var(--ink2)"> se perder</span></div>
      </div>
      ${v.zebra?'<div style="font-size:11px;color:var(--up);margin-top:6px">Zebra — ele está acima da sua faixa, a vitória multiplica os pontos.</div>':''}
    </div>

    <button onclick="_net.fecharPerfil();netDesafiar('${id}')"
      style="width:100%;margin-top:14px;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 15px system-ui;cursor:pointer">Desafiar ${primeiro}</button>

    ${_confrontoDireto(id)}

    <!-- troféus e patches chegam do banco; o miolo é trocado quando a consulta
         volta. Enquanto isso a seção diz que está buscando, em vez de afirmar
         "nenhum troféu" — que é o que um vazio otimista faria, e seria mentira
         pra quem tem. -->
    <div id="net-perfil-conq" style="margin-top:16px">
      <div style="font-size:11.5px;color:var(--ink3)">Buscando troféus e patches…</div>
    </div>

    ${amigo
      ? `<p style="font-size:11px;color:var(--ink3);text-align:center;margin-top:10px;line-height:1.5">Vocês já são amigos — dá pra desafiar em qualquer classe, sem a janela de ±1.</p>`
      : `<button onclick="_net.pedirAmizade('${id}','${(j.nome||'').replace(/'/g,"\\'")}')"
          style="width:100%;margin-top:8px;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:none;color:#fff;font:700 14px system-ui;cursor:pointer">Pedir pra ser amigo</button>
         <p style="font-size:11px;color:var(--ink3);text-align:center;margin-top:10px;line-height:1.5">Amizade é mútua: ele recebe o pedido e decide. Sendo amigos, vocês se desafiam em qualquer classe.</p>`}
  `);
  _carregarConquistas(id);
}

/* ---- as três seções que a ficha ganhou em 18/08 ------------------------
   Antes existiam DUAS fichas de jogador: esta (aberta pelo radar, com Desafiar
   e Pedir amizade) e a `jogador()` do index (aberta pelo quadro, com confronto
   direto e atributos). Mesma pergunta — "quem é essa pessoa?" — respondida pela
   metade em cada uma, e qual você via dependia de por onde tocou. É o mesmo
   defeito de superfícies que discordam que já mordeu o radar e a busca. Agora
   é uma só, e os dois caminhos abrem ela. */
/* Lê S.historico, que é estado do APARELHO: em celular novo vem vazio mesmo com
   as partidas registradas no banco. Por isso o texto do vazio não afirma "nunca
   jogaram" — diz que não se enfrentaram, sem cravar de onde vem a certeza.
   Levar o confronto direto pro banco é item à parte. */
function _confrontoDireto(id){
  const h = (S.historico||[]).filter(x=> x.adv===id);
  const linha = (t)=>`<div style="font-size:11.5px;color:var(--ink2);margin-top:5px">${t}</div>`;
  if(!h.length) return `<div style="margin-top:16px">
    <div style="font:700 11px system-ui;color:var(--ink2);text-transform:uppercase;letter-spacing:.07em">Confronto direto</div>
    ${linha('Vocês ainda não se enfrentaram.')}</div>`;
  const v = h.filter(x=>x.venceu).length;
  return `<div style="margin-top:16px">
    <div style="font:700 11px system-ui;color:var(--ink2);text-transform:uppercase;letter-spacing:.07em">Confronto direto</div>
    <div style="font:700 15px system-ui;margin-top:6px">${v} <span style="font-weight:400;font-size:12px;color:var(--ink2)">×</span> ${h.length-v}</div>
    ${h.slice(0,5).map(x=>linha(
      `<span style="color:${x.venceu?'var(--up)':'var(--dn)'}">${x.venceu?'venceu':'perdeu'}</span> ${x.placar||''}${x.quando?' · '+x.quando:''}`
    )).join('')}
    ${h.length>5?linha(`<span style="color:var(--ink3)">e mais ${h.length-5}</span>`):''}
  </div>`;
}

async function _carregarConquistas(id){
  const [trofeus, patches] = await Promise.all([
    netTrofeusDe(id).catch(()=>[]),
    netPatchesDe(id).catch(()=>[]),
  ]);
  const el = document.getElementById('net-perfil-conq');
  if(!el) return;                       // fechou a ficha antes de a consulta voltar
  const rot = (t)=>`<div style="font:700 11px system-ui;color:var(--ink2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${t}</div>`;
  const pil = (txt,cor)=>`<span style="display:inline-block;padding:4px 9px;border-radius:99px;background:var(--sup2);color:${cor};font:700 11px system-ui;margin:0 5px 5px 0">${_admEsc(txt)}</span>`;
  const bloco = [];
  if(trofeus.length) bloco.push(`<div>${rot(`Troféus · ${trofeus.length}`)}
    ${trofeus.map(t=> pil(`🏆 ${t.nome||t.tipo}${t.etiqueta?' · '+t.etiqueta:''}`, 'var(--gold)')).join('')}</div>`);
  if(patches.length) bloco.push(`<div style="margin-top:12px">${rot(`Patches · ${patches.length}`)}
    ${patches.map(p=> pil(`◈ ${p.patch.nome}`, 'var(--ink)')).join('')}</div>`);
  el.innerHTML = bloco.length ? bloco.join('')
    : `<div style="font-size:11.5px;color:var(--ink3)">Ainda não tem troféu nem patch.</div>`;
}

function netFecharPerfil(){ const el=document.getElementById('net-perfil'); if(el) el.remove(); }
window.netVerJogador = netVerJogador;

function netDesafiar(id){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const j = S.jogadores && S.jogadores[id];
  if(!j){ alert('Jogador não encontrado.'); return; }
  // o 📍 nasce preenchido com o MEU local principal — quem marca sabe onde
  // joga; trocar é exceção, não formulário (decisão de 11/08)
  const meu = window.__meusLocais || {};
  /* o principal só entra se AINDA for marcável: quem já tinha a quadra
     particular de outro salvada como principal (a lista de "Onde você joga"
     oferecia isso) nasceria com um local que a trava (0) recusa, e o desafio
     morreria no envio. Esconder da lista conserta daqui pra frente; isto
     conserta quem já escolheu. */
  const princ = meu.principal && _locaisMarcaveis().some(l=>l.id===meu.principal)
    ? meu.principal : null;
  _on = { step:'desafio', advId:id, adv:{id, nome:j.nome, nivel:j.nivel, nivelb:j.nivelB,
            nivel_duplas:j.nivel_duplas, nivelb_duplas:j.nivelb_duplas},
          localId: princ, quadra: null, quando: null,
          quadraPor: null, bolaPor: null,
          // (45) nasce simples: duplas é escolha explícita, nunca default
          dupla: false, parCri: null, parAdv: null };
  _farmContar(id);   // 5ª do mês contra ele? o aviso chega antes do Desafiar
  netRenderOnline();
}
window.netDesafiar = netDesafiar;
/* Tirar o local zera quem leva a quadra: sem lugar o seletor some da tela, e
   um `quadraPor` cheio por trás de um campo invisível é estado fantasma — o
   mesmo tipo de bug que o `value=` preenchido de volta no datetime evita. */
function _onLocal(v){ _on.localId = v || null; _on.quadra = null;
  if(!_on.localId) _on.quadraPor = null;
  netRenderOnline(); }
/* 'eu' | 'ele' | null — vira uuid só na hora de gravar. Clicar no que já está
   escolhido desmarca: a escolha é opcional e precisa ter volta. */
function _onQuadraPor(v){ _on.quadraPor = (_on.quadraPor===v) ? null : v; netRenderOnline(); }
function _onBolaPor(v){   _on.bolaPor   = (_on.bolaPor===v)   ? null : v; netRenderOnline(); }
const _porUid = (lado)=> lado==='eu' ? MEU_UID : lado==='ele' ? (_on.advId||null) : null;
const _quadraPorUid = ()=> _porUid(_on.quadraPor);
const _bolaPorUid   = ()=> _porUid(_on.bolaPor);
function _onQuadra(v){
  const l=_locDe(_on.localId); const max=l?l.quadras:60;
  const n=parseInt(v,10);
  _on.quadra = (n>=1 && n<=max) ? n : null;
}
/* o input datetime-local entrega "2026-08-15T19:00" no fuso do aparelho;
   new Date() interpreta nesse fuso e o toISOString normaliza pra UTC — o
   banco guarda timestamptz e cada aparelho mostra na sua hora */
function _onQuando(v){
  const d = v ? new Date(v) : null;
  _on.quando = (d && !isNaN(d)) ? d.toISOString() : null;
}

/* O atalho precisa REDESENHAR; o input não pode. São dois caminhos porque o
   efeito colateral é diferente: redesenhar enquanto a pessoa mexe no seletor
   nativo tiraria o foco dela no meio. Vindo do chip, redesenhar é obrigatório
   — senão o valor entra no estado e a tela não mostra nada, que é estado
   invisível virando bug fantasma. */
function _onQuandoAtalho(v){
  _onQuando(v);
  netRenderOnline();
}

/* ---- duplas na tela de desafio (mig 45) --------------------------------
   O toggle e os dois seletores. Trocar de modo LIMPA os parceiros: um id de
   parceiro sobrevivendo num desafio de simples seria estado invisível, e o
   `matches_parceiros_so_em_dupla` recusaria o insert com uma mensagem que não
   foi escrita pra ninguém ler. */
function _onDupla(v){
  _on.dupla = !!v;
  if(!_on.dupla){ _on.parCri=null; _on.parAdv=null; }
  netRenderOnline();
}
function _onParceiro(qual, id){
  _on[qual==='meu' ? 'parCri' : 'parAdv'] = id || null;
  netRenderOnline();
}
/* Quem pode ser parceiro: gente de verdade, não banida, e que não seja um dos
   dois capitães nem o outro parceiro — a constraint `matches_quatro_distintos`
   cobra os quatro distintos, e oferecer na lista quem o banco vai recusar é
   fabricar um erro. Amigos primeiro: parceiro de duplas é escolha social. */
function _parceirosPossiveis(excluir){
  const fora = new Set([MEU_UID, _on.advId, ...(excluir||[])].filter(Boolean));
  return Object.keys(S.jogadores||{})
    .filter(id=> id!==EU && S.jogadores[id] && !S.jogadores[id].banido)
    /* `S.jogadores` é chaveado pelo UID (ver `_chaveLocal`: só o EU tem chave
       própria, e ele já saiu no filtro acima). Então a chave É o id que vai
       pro banco — sem tradução, sem inventar um mapa que não existe. */
    .map(id=> ({ id, j:S.jogadores[id] }))
    .filter(x=> !fora.has(x.id))
    .sort((a,b)=> (netEhAmigo(b.id)?1:0)-(netEhAmigo(a.id)?1:0)
                || (a.j.nome||'').localeCompare(b.j.nome||''));
}

/* O bloco Simples/Duplas — UM só, usado pela folha do desafio E pela do
   "lançar na mão" (20/08). Eram duas telas que fazem a mesma pergunta, e duas
   cópias do mesmo seletor divergem na primeira vez que uma delas muda.
   `nomeAdv` e `rodape` são o que difere: no desafio o jogo vai acontecer e os
   quatro precisam topar; na mão o jogo já aconteceu e só falta confirmar. */
function _duplaBloco(nomeAdv, rodape){
  const aba=(on,rot,val)=>`<button type="button" onclick="_net.onDupla(${val})"
    style="flex:1;padding:10px;border-radius:10px;font:700 13px system-ui;cursor:pointer;
           border:1px solid ${on?'var(--lime)':'var(--linha2)'};
           background:${on?'rgba(131,224,0,.12)':'transparent'};
           color:${on?'var(--lime)':'var(--ink2)'}">${rot}</button>`;
  const sel=(qual,valor,excluir,rot)=>{
    const ops=_parceirosPossiveis(excluir);
    return `<div style="font-size:12px;color:var(--ink2);margin:8px 0 6px">${rot} ${valor?'':'<span style="color:var(--dn)">— escolha</span>'}</div>
    <select onchange="_net.onParceiro('${qual}',this.value)"
      style="width:100%;padding:12px;border-radius:12px;background:var(--bg);color:#fff;font:600 14px system-ui;
             border:1px solid ${valor?'var(--linha2)':'var(--dn)'}">
      <option value="" ${!valor?'selected':''}>Quem joga?</option>
      ${ops.map(o=>`<option value="${o.id}" ${valor===o.id?'selected':''}>${o.j.nome}${netEhAmigo(o.id)?' · amigo':''}</option>`).join('')}
    </select>`;
  };
  return `<div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">🎾 Como ${rodape?'jogaram':'vão jogar'}</div>
    <div style="display:flex;gap:6px">${aba(!_on.dupla,'Simples',false)}${aba(!!_on.dupla,'Duplas',true)}</div>
    ${_on.dupla ? sel('meu', _on.parCri, [_on.parAdv], '👤 Seu parceiro')
                  + sel('deles', _on.parAdv, [_on.parCri], `👤 Parceiro de ${nomeAdv}`)
                  + `<div style="font-size:11.5px;color:var(--ink3);margin-top:7px">${rodape
                      || 'Os quatro precisam topar. Se um recusar, o desafio morre — e vocês marcam outro.'}</div>`
                : ''}
    <div style="height:12px"></div>`;
}

async function _onConfirmarDesafio(){
  const adv=_on.adv;
  /* 16/08 — a data virou obrigatória (mig 34). A trava de verdade é a do
     banco; esta aqui é a cortesia de avisar antes, com a palavra da tela em
     vez do erro do Postgres. Sem ela o app manda `quando: null`, o trigger
     recusa e a pessoa vê uma mensagem que não foi escrita pra ela. */
  if(!_on.quando){
    if(window.toast) toast('Escolha o dia e a hora do jogo.');
    return;
  }
  /* (45) DUPLAS NASCE COM OS QUATRO — a trava (15a) do guard recusa o insert
     sem os dois parceiros. Avisar aqui é a cortesia de sempre: a trava de
     verdade é a do banco, esta fala a língua de quem está na tela. */
  if(_on.dupla && (!_on.parCri || !_on.parAdv)){
    if(window.toast) toast(!_on.parCri ? 'Escolha o seu parceiro.' : 'Escolha o parceiro do adversário.');
    return;
  }
  try{
    const { error } = await sb.from('matches').insert({
      criador_id: MEU_UID, adversario_id: adv.id,
      esporte: (typeof S!=='undefined' && S.esporte) ? S.esporte : 'tenis',
      formato:'md3', dupla: !!_on.dupla, status:'desafiado', cantada:null,
      /* Só viajam em duplas: em simples as colunas ficam NULL por construção,
         que é o que `matches_parceiros_so_em_dupla` cobra. */
      ...(_on.dupla ? { parceiro_criador_id:_on.parCri, parceiro_adversario_id:_on.parAdv } : {}),
      local_id: _on.localId || null, quadra: _on.quadra || null,
      quando: _on.quando || null,
      // só entram na criação: a trava (5) do trigger congela os dois no
      // UPDATE, e daí em diante eles só mudam pela contraproposta
      quadra_por: _quadraPorUid(), bola_por: _bolaPorUid(),
    });
    if(error) throw error;
    netFecharOnline();
    if(window.toast) toast(_on.dupla
      ? `Duplas proposta — os outros três precisam topar no app deles.`
      : `Desafio enviado pra ${adv.nome.split(' ')[0]} — ele aceita no app dele.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra desafiar: '+(e.message||e)); }
}

/* ---- contraproposta: abrir e enviar (mig 25) ---------------------------
   Reaproveita a folha do desafio inteira — os campos combinados são os mesmos
   quatro, e quem propõe outro dia está respondendo o mesmo formulário. Nasce
   preenchida com o que está na mesa hoje: contraproposta é edição do
   combinado, não formulário em branco. */
function netAbrirContra(matchId){
  const m = _inbox.find(x=>x.id===matchId); if(!m){ alert('Partida não encontrada.'); return; }
  const uid = _advId(m);
  const j = S.jogadores[_chaveLocal(uid)] || { nome:_nomeDe(uid) };
  // se já há proposta na mesa, o ponto de partida é ELA; senão, o combinado
  const base = m.prop_por ? 'prop_' : '';
  const lado = (uidCol)=> uidCol ? (uidCol===MEU_UID?'eu':'ele') : null;
  _on = { step:'contra', matchId, advId:uid, adv:{ id:uid, nome:j.nome },
          localId: m[base+'local_id'] || null,
          quadra:  m[base+'quadra']   || null,
          quando:  m[base+'quando']   || null,
          quadraPor: lado(m[base+'quadra_por']),
          bolaPor:   lado(m[base+'bola_por']),
          rodadas: m.prop_rodadas||0 };
  _farmContar(uid);   // a contraproposta é a mesma 5ª partida — avisa igual
  netRenderOnline();
}
async function _onEnviarContra(){
  try{
    const { error } = await sb.rpc('contraproposta_por', {
      p_match: _on.matchId, p_quando: _on.quando || null,
      p_local: _on.localId || null, p_quadra: _on.quadra || null,
      p_quadra_por: _quadraPorUid(), p_bola_por: _bolaPorUid(),
    });
    if(error) throw error;
    const nome0=_on.adv.nome.split(' ')[0];
    netFecharOnline();
    if(window.toast) toast(`Proposta enviada — ${nome0} responde no app dele.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra propor: '+(e.message||e)); netAtualizarInbox(); }
}

/* ---- lançar na mão (11/08, migração 24) --------------------------------
   Partida jogada FORA do app. Nasce direto em 'pendente' com o placar e
   placar_por=eu — o adversário confirma/contesta no fluxo que já existe, com
   o relógio das 72h e tudo. `origem='mao'` é o que a regra "não conta em
   circuito aberto" vai ler quando o aberto existir.
   Pool de adversário: amigo (qualquer classe) OU ±1 classe — o teste da fila
   no topo vale pra toda superfície nova, e esta não fura a janela. */
function netAbrirMao(){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const meu = window.__meusLocais || {};
  _on = { step:'mao', advId:'', sets:null, placarTxt:'',
          fmt:'md3', localId: meu.principal || null, quadra:null, quando:null,
          // (20/08) duplas também se lança na mão. Nasce simples: como no
          // desafio, duplas é escolha explícita e nunca default.
          dupla:false, parCri:null, parAdv:null };
  netRenderOnline();
}
window.netAbrirMao = netAbrirMao;
/* Trocar de adversário LIMPA o parceiro dele: o `_parceirosPossiveis` exclui
   os capitães, e um id que era válido com o adversário anterior pode passar a
   ser o próprio adversário agora — a constraint `matches_quatro_distintos`
   recusaria, com uma mensagem escrita pra quem lê SQL. */
function _maoAdv(v){ _on.advId=v||''; if(_on.parAdv===_on.advId) _on.parAdv=null;
                     if(_on.parCri===_on.advId) _on.parCri=null;
                     _on.nPar=undefined;   // a contagem é DESTE par — a do anterior não vale
                     if(_on.advId) _farmContar(_on.advId);
                     netRenderOnline(); }
function _maoFmt(v){ _on.fmt=v; netRenderOnline(); }
function _maoElegiveis(){
  const eu=S.jogadores[EU];
  const ordem=['A','B','C','D']; const i=ordem.indexOf(divDe(eu));
  const janela=[ordem[i-1],divDe(eu),ordem[i+1]].filter(Boolean);
  return Object.keys(S.jogadores)
    .filter(id=>id!==EU && S.jogadores[id])
    .filter(id=> netEhAmigo(id) || janela.includes(divDe(S.jogadores[id])));
}
async function _maoEnviar(){
  if(!_on.advId){ alert('Escolhe o adversário.'); return; }
  /* (20/08) DUPLAS NASCE COM OS QUATRO — a trava (15a) do guard recusa o
     INSERT sem os dois parceiros. Avisar aqui é a cortesia de sempre: a trava
     de verdade é a do banco, esta fala a língua de quem está na tela. */
  if(_on.dupla && (!_on.parCri || !_on.parAdv)){
    alert(!_on.parCri ? 'Escolhe o seu parceiro.' : 'Escolhe o parceiro do adversário.');
    return;
  }
  const sets=_on.sets; if(!sets){ alert('Placar incompleto. Ex: 6-3 6-4'); return; }
  let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
  if(g===p){ alert('Placar empatado — confere os sets.'); return; }
  try{
    /* PARTIDA JÁ JOGADA NASCE 'pendente', inclusive em duplas — e isso NÃO
       fere a decisão de 19/08 ("os quatro aceitam a partida"), que é sobre
       MARCAR jogo, não sobre registrar jogo passado. Não há o que combinar
       num jogo que acabou; o que existe é um placar pra confirmar, e quem
       confirma é o capitão adversário, como já é no simples.

       O banco concorda por construção: a trava (17) só dispara em
       `desafiado → aceito` (mig 47:316), e esta partida nunca passa por
       'aceito' — nasce 'pendente' e vai pra 'confirmada'. Os carimbos de
       aceite ficam nulos, que é o registro honesto de que ninguém aceitou
       nada: não houve convite. */
    const { error } = await sb.from('matches').insert({
      criador_id: MEU_UID, adversario_id: _on.advId,
      esporte: (typeof S!=='undefined' && S.esporte) ? S.esporte : 'tenis',
      formato:_on.fmt, dupla: !!_on.dupla, cantada:null,
      ...(_on.dupla ? { parceiro_criador_id:_on.parCri, parceiro_adversario_id:_on.parAdv } : {}),
      status:'pendente', sets, placar:sets.map(([a,b])=>`${a}-${b}`).join(' '),
      venceu_criador: g>p, placar_por: MEU_UID,
      placar_em: new Date().toISOString(),        // o relógio das 72h começa aqui
      quando: _on.quando || null,
      local_id: _on.localId || null, quadra: _on.quadra || null,
      origem: 'mao',
    });
    if(error) throw error;
    const nome0=_nomeDe(_on.advId).split(' ')[0];
    netFecharOnline();
    if(window.toast) toast(_on.dupla
      ? `Duplas lançada — ${nome0} confirma no app dele. Nada mexe até lá.`
      : `Placar lançado — ${nome0} confirma no app dele. Nada mexe até lá.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra lançar: '+(e.message||e)); }
}

/* ---- 2a: aceitar / recusar (do lado de quem recebeu) ------------------ */
async function netAceitar(matchId){
  /* (45) EM DUPLAS OS QUATRO TOPAM PRIMEIRO. A trava (17) recusa o aceite
     enquanto faltar carimbo, e a mensagem dela é escrita pra quem lê SQL. A
     cortesia é a mesma da data obrigatória: dizer antes, com a palavra da
     tela, quem ainda não respondeu. */
  const md = (_inbox||[]).find(x=>x.id===matchId);
  if(md && md.dupla && (!md.aceite_parceiro_criador || !md.aceite_parceiro_adversario)){
    const falta = !md.aceite_parceiro_criador ? md.parceiro_criador_id : md.parceiro_adversario_id;
    if(window.toast) toast(`Falta ${_nomeDe(falta).split(' ')[0]} topar a duplas — o desafio abre quando os quatro responderem.`);
    return;
  }
  const { error } = await sb.from('matches').update({ status:'aceito', aceito_at:new Date().toISOString() }).eq('id',matchId);
  if(error){ alert('Erro ao aceitar: '+error.message); return; }
  if(window.toast) toast('Desafio aceito! Agora é só jogar e lançar o placar.');
  netAtualizarInbox();
}
async function netRecusar(matchId){
  const { error } = await sb.from('matches').update({ status:'recusado' }).eq('id',matchId);
  if(error){ alert('Erro: '+error.message); return; }
  netAtualizarInbox();
}

/* ---- 2a-duplas: o aceite do PARCEIRO (mig 45) --------------------------
   Irmão do check-in: carimbo pessoal, write-once, e o VALOR é imposto pelo
   trigger com `now()` — o que mandamos daqui é só o sinal de que o toque
   aconteceu. Mandar `new Date()` seria data de presença escrita pelo próprio
   interessado, que é o que a trava (16) recusa; o banco sobrescreve de todo
   jeito, e a linha existe só pra o `is distinct from` disparar.

   Não é função RPC de propósito: a fechadura mora no guard, e o caminho é o
   mesmo `update` que o app já sabe fazer. */
async function netAceitarParceiro(matchId){
  const m = (_inbox||[]).find(x=>x.id===matchId);
  const col = m && _meuAceitePendente(m);
  if(!col){ netAtualizarInbox(); return; }
  const { error } = await sb.from('matches').update({ [col]: new Date().toISOString() }).eq('id',matchId);
  if(error){ alert('Não deu pra aceitar: '+error.message); return; }
  /* Quem fecha o convite é o capitão adversário, e ele só consegue depois dos
     DOIS carimbos (trava 17). Dizer isso aqui evita a pergunta "aceitei, e
     agora?" — o estado real é "falta o outro par e o capitão". */
  const outro = (col==='aceite_parceiro_criador') ? m.aceite_parceiro_adversario
                                                  : m.aceite_parceiro_criador;
  if(window.toast) toast(outro
    ? 'Você topou! Agora é com o capitão adversário fechar o desafio.'
    : 'Você topou! Falta o outro parceiro responder.');
  netAtualizarInbox();
}
window.netAceitarParceiro = netAceitarParceiro;

/* ---- 2a-bis: presença (mig 25) ----------------------------------------
   O valor mandado é só um carimbo de intenção — a trava (7) do trigger
   sobrescreve com `now()` do servidor. É de propósito: hora de chegada que o
   aparelho escolhe é hora que o aparelho pode mentir. */
async function netCheckin(matchId){
  const m = _inbox.find(x=>x.id===matchId); if(!m) return;
  const campo = _souCriador(m) ? 'checkin_criador' : 'checkin_adversario';
  const { error } = await sb.from('matches')
    .update({ [campo]: new Date().toISOString() }).eq('id',matchId);
  if(error){ alert('Não deu pra fazer check-in: '+error.message); return; }
  if(window.toast) toast('✅ Check-in feito — tá na quadra.');
  netAtualizarInbox();
}

/* ---- 2a-ter: contraproposta (mig 25) ----------------------------------
   Aceitar a proposta é o mesmo ato que aceitar o desafio — só que o combinado
   que passa a valer é o proposto. Quem faz a troca é a função, em bloco: ela
   copia os `prop_*` pro combinado, limpa a mesa e põe o status em 'aceito'.
   As mensagens de erro dela já são texto de gente ("a vez é do outro jogador",
   "limite de idas e voltas; aceite ou recuse") — passam direto, sem tradução. */
async function netAceitarContra(matchId){
  const { error } = await sb.rpc('contraproposta_aceitar', { p_match: matchId });
  if(error){ alert('Não deu pra aceitar: '+error.message); netAtualizarInbox(); return; }
  if(window.toast) toast('Combinado! Agora é só jogar e lançar o placar.');
  netAtualizarInbox();
}

/* ---- 2b: lançar o placar (partida já aceita) -------------------------- */
async function netLancarPlacar(matchId){
  const m = _inbox.find(x=>x.id===matchId); if(!m) return;
  const advUid = _advId(m); const j = S.jogadores[_chaveLocal(advUid)] || {nome:'Jogador'};
  // ctx/fmt/dupla viajam no _on pra que a PRÉVIA mostre a mesma conta que a
  // confirmação vai aplicar — prévia que mente é pior que prévia que não existe
  _on = { step:'placar', matchId, souCriador:_souCriador(m),
          ctx:_ctxDoTorneio(await _torneioDe(m.torneio_id)), fmt:m.formato, dupla:!!m.dupla,
          /* a ladder viaja junto (mig 46): sem ela `_ladderDe` cairia no Nível
             de simples e a prévia de uma duplas mostraria o número do trilho
             errado — a mesma conta que o banco NÃO vai fazer. */
          adv:{id:advUid, nome:j.nome, nivel:j.nivel, nivelb:j.nivelB,
               nivel_duplas:j.nivel_duplas, nivelb_duplas:j.nivelb_duplas},
          /* Os parceiros POR ASSENTO, não por coluna. `parceiro_criador_id` é o
             parceiro do CRIADOR — se eu for o adversário, ele é do outro time.
             Resolver aqui evita a prévia trocar os dois lados e mostrar a
             média do time errado justamente pra quem está lançando. */
          parMeu:  _souCriador(m) ? m.parceiro_criador_id : m.parceiro_adversario_id,
          parDele: _souCriador(m) ? m.parceiro_adversario_id : m.parceiro_criador_id,
          sets:null, placarTxt:'' };
  _farmContar(advUid);   // a prévia dos Pontos precisa da contagem pra não mentir
  netRenderOnline();
}

async function _onEnviar(){
  const sets=_on.sets; if(!sets || !_on.matchId) return;
  let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
  const euVenci = g>p;
  // guarda tudo na perspectiva do CRIADOR, pra a linha ser canônica
  const setsC = _on.souCriador ? sets : sets.map(([a,b])=>[b,a]);
  const venceuCriador = _on.souCriador ? euVenci : !euVenci;
  const placarC = setsC.map(([a,b])=>`${a}-${b}`).join(' ');
  try{
    const { error } = await sb.from('matches').update({
      sets:setsC, placar:placarC, venceu_criador:venceuCriador, placar_por:MEU_UID, status:'pendente',
      placar_em:new Date().toISOString(),   // 11/08: o relógio das 72h começa aqui
    }).eq('id',_on.matchId);
    if(error) throw error;
    netFecharOnline();
    if(window.toast) toast(`Placar enviado — ${_on.adv.nome.split(' ')[0]} confirma no app dele. Nada mexe até lá.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra enviar: '+(e.message||e)); }
}

/* ---- contexto por escopo (09/08) ---------------------------------------
   Até aqui TODA partida entrava no motor como 'amistoso' (6 pts): um Open valia
   o mesmo que um treino de sábado. O contexto agora vem de onde a partida
   aconteceu.

   Derivado, não guardado — `grupo_id` já separa privado de público, e estado
   derivado não se guarda. A única exceção é `oficial`: é fato externo (chancela
   da Walk, não SKU), não dá pra derivar, então é coluna. Ver migração 10. */
const _tCache = {};
async function _torneioDe(tid){
  if(!tid) return null;
  if(_tCache[tid] !== undefined) return _tCache[tid];
  let { data, error } = await sb.from('torneios').select('id,grupo_id,oficial').eq('id',tid).maybeSingle();
  if(error){   // migração 10 ainda não rodou — segue sem a chancela, não quebra
    ({ data } = await sb.from('torneios').select('id,grupo_id').eq('id',tid).maybeSingle());
  }
  _tCache[tid] = data || null;
  return _tCache[tid];
}
function _ctxDoTorneio(t){
  if(!t)        return 'amistoso';                  // 6  — partida avulsa
  if(t.oficial) return 'oficial';                   // 48 — chancela da Walk
  return t.grupo_id ? 'copa_panela' : 'publico';    // 12 privado · 24 público
}

/* ---- 2b: confirmar / contestar (do lado de quem recebeu o placar) ----- */

/* O cálculo dos deltas saiu de dentro do netConfirmar (11/08) porque agora
   tem dois caminhos que fecham partida: a confirmação do adversário (fator 1)
   e o vencimento do prazo de 72h (fator 0,5). O cálculo tem que ser o MESMO
   nos dois — duas cópias divergem no primeiro ajuste do motor. */
async function _deltasDaPartida(m, fator){
  // nível dos dois, direto do banco (autoridade), pelo esporte da partida
  const { data:ps } = await sb.from('players').select('id,nivel,nivelb,calibrando,cal').in('id',[m.criador_id,m.adversario_id]);
  const byId={}; (ps||[]).forEach(p=>byId[p.id]=p);
  const nv = (uid)=> m.esporte==='beach' ? (byId[uid]?.nivelb ?? 1200) : (byId[uid]?.nivel ?? 1200);
  const nC=nv(m.criador_id), nA=nv(m.adversario_id);
  // formato/dupla vinham hardcoded — a partida sempre contou como melhor de 3
  // e simples, mesmo com os valores reais gravados na própria linha
  const ctx = _ctxDoTorneio(await _torneioDe(m.torneio_id));
  const dC = calcular(nC, nA,  m.venceu_criador, ctx, m.formato, m.dupla, byId[m.criador_id]?.calibrando,     byId[m.criador_id]?.cal);
  const dA = calcular(nA, nC, !m.venceu_criador, ctx, m.formato, m.dupla, byId[m.adversario_id]?.calibrando, byId[m.adversario_id]?.cal);
  return [_aplicarFator(dC,fator), _aplicarFator(dA,fator)];
}

/* Um fator só derruba Nível e Pontos juntos: o `pontos_creditar` no banco lê
   `delta_*->>'dPts'` DESTA linha, então não há um segundo lugar pra esquecer.
   O piso de 1 é decisão de produto: a partida aconteceu, e metade virar zero
   faria o prazo apagar o jogo em vez de reduzi-lo. */
function _aplicarFator(d, fator){
  if(fator === 1) return d;
  const meio = (v)=> v===0 ? 0 : (v>0 ? Math.max(1, Math.round(v*fator)) : Math.min(-1, Math.round(v*fator)));
  return { ...d, dNivel: meio(d.dNivel), dPts: meio(d.dPts) };
}

/* ---- (16/08, na tela só agora) O ANTI-FARM AVISA ANTES, NÃO SURPREENDE DEPOIS
   O motor cobra 25% dos Pontos da 5ª partida do mês contra a mesma pessoa
   (mig 33) — e regra que só existe no documento não muda comportamento: quem
   marca a 5ª precisa saber ANTES de marcar. A contagem espelha a do
   `pontos_creditar`: par canônico criador/adversário (parceiro não entra),
   confirmadas, `coalesce(confirmed_at, created_at)` no mês corrente em UTC —
   que é o relógio do `date_trunc` do banco, não o do aparelho.
   E o aviso é honesto no que NÃO muda: o Nível conta cheio. Ele mede o jogo;
   os Pontos medem a temporada, e o farm mora nos Pontos. */
async function _farmContar(advId){
  if(!MEU_UID || !advId) return;
  const alvo = _on;                     // o sheet pode trocar antes da resposta
  try{
    /* uma consulta, duas réguas: o anti-farm conta por MÊS, a zebra (53) por
       TEMPORADA — e os flags de zebra já viajam nos deltas gravados */
    const r = await sb.from('matches')
      .select('confirmed_at,created_at,zc:delta_criador->>zebra,za:delta_adversario->>zebra')
      .eq('status','confirmada')
      .or(`and(criador_id.eq.${MEU_UID},adversario_id.eq.${advId}),`
        + `and(criador_id.eq.${advId},adversario_id.eq.${MEU_UID})`);
    if(r.error || _on !== alvo) return;
    const mes = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    _on.nPar = (r.data||[]).filter(x=> Date.parse(x.confirmed_at || x.created_at) >= mes).length;
    /* (53) o par já zebrou nesta temporada? A régua é o `inicio` da temporada
       vigente. Se a leitura falhar, `zebraJa` fica false e a prévia sai cheia
       — otimista, mas o banco cobra certo de qualquer jeito. */
    try{
      const agora = new Date().toISOString();
      const t = await sb.from('temporadas').select('inicio')
        .lte('inicio', agora).gt('fim', agora)
        .order('n',{ascending:false}).limit(1).maybeSingle();
      const ini = t.data && Date.parse(t.data.inicio);
      _on.zebraJa = !!ini && (r.data||[]).some(x=>
        Date.parse(x.confirmed_at || x.created_at) >= ini && (x.zc==='true' || x.za==='true'));
    }catch(e){ _on.zebraJa = false; }
    // só re-renderiza quem está NA zona: fora dela a tela não muda, e um
    // re-render gratuito no meio da digitação do placar derrubaria o foco
    if(_on.nPar >= 4 || _on.zebraJa) netRenderOnline();
  }catch(e){}
}
// o mesmo meio do `_motor_meio`/`_aplicarFator`: piso de 1 em módulo — a
// prévia mostra o número que o banco vai creditar, nunca o cheio
function _farmPts(v){ return v===0 ? 0 : (v>0 ? Math.max(1, Math.round(v*0.25)) : Math.min(-1, Math.round(v*0.25))); }
function _farmAviso(nome){
  if(!_on || !(_on.nPar >= 4)) return '';
  return `<div style="margin:10px 0;padding:10px 12px;border-radius:11px;border:1px solid var(--gold);color:var(--gold);font:600 12px system-ui;line-height:1.5">${_on.nPar+1}ª partida contra ${nome} este mês — vale 25% dos Pontos. O Nível conta cheio.</div>`;
}

async function netConfirmar(matchId){
  const m = _inbox.find(x=>x.id===matchId); if(!m) return;
  try{
    const [dC,dA] = await _deltasDaPartida(m, 1);
    const { error } = await sb.from('matches').update({
      status:'confirmada', delta_criador:dC, delta_adversario:dA, confirmed_at:new Date().toISOString(),
    }).eq('id',matchId);
    if(error) throw error;
    if(window.toast) toast('Placar confirmado! O ciclo fechou.');
    await netCreditarPontos(matchId);
    await _cinturaoTentarPassar(m);
    netAtualizarInbox();   // aplica meu delta e re-renderiza
  }catch(e){ alert('Erro ao confirmar: '+(e.message||e)); }
}

/* ---- 2c: o prazo de 72h (11/08) ---------------------------------------
   A tela promete "se não responder em 72h, o placar vale metade" desde o
   começo e nada cumpria — `pendente` só saía de lá pela mão do adversário.
   Partida parada é quem lançou o placar sem receber nada, no elo mais frágil
   do ciclo.

   Resolve na LEITURA, como o vencimento do cinturão logo abaixo: quem abrir
   o app primeiro apura. Sem agendador, sem função nova no banco, e testável
   antes de entregar — complexidade que não dá pra testar é risco puro.       */
/* 16/08 — O RELÓGIO PASSA A CONTAR DE QUANDO A PESSOA VIU.
   Vence em `min(visto + 24h, lançamento + 72h)`.

   O prazo curto é o que o produto quer: 72h é uma eternidade pra confirmar um
   placar. Mas contar 24h de quem nunca soube que havia placar é cobrar de
   quem não foi avisado — daí o carimbo `visto_por_adversario_em`, escrito no
   boot pelo servidor (mig 34).

   O TETO NÃO É DETALHE: sem ele, "não abrir o app" vira estratégia pra quem
   está perdendo — o relógio nunca começa e a partida nunca fecha. É o irmão
   exato da regra do cinturão: se o prejuízo pode ser evitado parando, a regra
   está apontada contra o produto.

   Sem carimbo (cliente velho, ou quem ainda não abriu), cai no teto — que é
   exatamente o comportamento de antes. O prazo nunca fica MAIOR que era. */
const PRAZO_TETO_H  = 72;   // do lançamento, sempre
const PRAZO_VISTO_H = 24;   // de quando o adversário viu
const _vencendo = {};   // guarda de reentrada, igual ao _expirando do cinturão

/* Os atalhos que tornam a data obrigatória quase gratuita: um toque em vez de
   abrir o seletor e rolar três rodinhas. Um campo obrigatório sem atalho é
   atrito no elo frágil do ciclo; com atalho, é o app perguntando o que a
   pessoa já ia responder.

   "Hoje 19h" só aparece enquanto ainda dá tempo — oferecer um horário que já
   passou seria oferecer um erro, já que o banco tem piso de data (mig 35). */
function _atalhosQuando(){
  const agora = new Date();
  const em = (dias, h) => { const d = new Date(agora); d.setDate(d.getDate()+dias); d.setHours(h,0,0,0); return d; };
  const lista = [];

  const hoje19 = em(0, 19);
  if(hoje19.getTime() > agora.getTime() + 36e5) lista.push({ rot:'Hoje 19h', d: hoje19 });

  lista.push({ rot:'Amanhã 19h', d: em(1, 19) });

  // próximo sábado às 9h — o horário de clube por excelência
  const faltaSab = (6 - agora.getDay() + 7) % 7 || 7;
  lista.push({ rot:'Sábado 9h', d: em(faltaSab, 9) });

  return lista.slice(0, 3);
}

/* Devolve o instante do vencimento em MILISSEGUNDOS — nunca texto.
   Comparar timestamp como string erra em silêncio: o Postgres devolve
   `...+00:00` e o `toISOString()` produz `...Z`, e as duas divergem no meio do
   carimbo sem levantar erro nenhum. */
function _venceEm(m){
  if(!m.placar_em) return null;
  const teto = new Date(m.placar_em).getTime() + PRAZO_TETO_H*3600e3;
  if(!m.visto_por_adversario_em) return teto;
  const curto = new Date(m.visto_por_adversario_em).getTime() + PRAZO_VISTO_H*3600e3;
  return Math.min(curto, teto);
}

function _prazoVencido(m){
  if(m.status !== 'pendente' || !m.placar_em) return false;
  /* (45/47) QUEM APURA É CAPITÃO. O parceiro passou a VER a partida na caixa
     (a `matches_select` abriu pros quatro), e apurar prazo é ESCREVER status —
     a trava (19) recusa isso vindo dele. Sem esta linha o app do parceiro
     tentaria fechar, tomaria o erro, e o `catch` do `netApurarPrazos` apaga a
     guarda de reentrada: uma tentativa recusada POR ATUALIZAÇÃO, pra sempre.
     Ler não é poder agir — o relógio corre pros capitães. */
  if(m.dupla && !_souCapitao(m)) return false;
  const vence = _venceEm(m);
  return vence !== null && Date.now() > vence;
}

async function _fecharPorPrazo(m){
  const [dC,dA] = await _deltasDaPartida(m, 0.5);
  // `.eq('status','pendente')` é a trava contra corrida: se o adversário
  // confirmou no meio do caminho, ou o outro aparelho apurou primeiro, esta
  // escrita não encontra linha — e o `select` devolve vazio em vez de erro.
  const { data, error } = await sb.from('matches').update({
    status:'confirmada', delta_criador:dC, delta_adversario:dA,
    confirmed_at:new Date().toISOString(), fechada_por_prazo:true,
  }).eq('id', m.id).eq('status','pendente').select('id');
  if(error) throw error;
  if(!data || !data.length) return false;   // alguém chegou antes: nada a fazer
  await netCreditarPontos(m.id);
  await _cinturaoTentarPassar(m);
  return true;
}

/* O relógio precisa aparecer nos DOIS lados, e dizendo coisas diferentes.
   Pra quem tem que confirmar, o prazo é cobrança: se não responder, o placar
   fecha sem você. Pra quem lançou e espera, é garantia: não vai ficar parado
   pra sempre. A mesma regra, lida de dois jeitos — e nenhum dos dois pode
   descobrir a existência do prazo só depois que ele venceu. */
function _horasRestantes(m){
  const vence = _venceEm(m);
  if(vence === null) return null;
  return Math.max(0, (vence - Date.now()) / 3600e3);
}
/* Mostra o PRAZO, não a contagem regressiva. Contagem tem erro de borda que
   não dá pra esconder: 71,9h restantes viram "2 dias" no floor e "3 dias" no
   ceil, e as duas leituras estão erradas de um jeito diferente. Data e hora
   não têm ambiguidade — e é o que a pessoa precisa pra se organizar.
   A contagem volta só na reta final, quando "faltam 3h" é mais útil que
   "quinta, 14h". */
const _DIAS = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
function _quandoVence(m){
  const t = _venceEm(m);           // o mesmo mínimo que o `_prazoVencido` usa
  return t === null ? null : new Date(t);
}
function _avisoPrazo(m, lado){
  const h = _horasRestantes(m); if(h === null) return '';
  const venceEm = _quandoVence(m);
  const hoje = new Date();
  const mesmoDia = venceEm.toDateString() === hoje.toDateString();
  const amanha = venceEm.toDateString() === new Date(hoje.getTime()+864e5).toDateString();
  const quando = mesmoDia ? `hoje às ${venceEm.getHours()}h`
               : amanha   ? `amanhã às ${venceEm.getHours()}h`
               : `${_DIAS[venceEm.getDay()]} às ${venceEm.getHours()}h`;
  const resta = h < 12 ? (h < 1 ? 'menos de 1h' : `${Math.round(h)}h`) : null;

  const txt = lado === 'confirmar'
    ? (h <= 0 ? 'O prazo venceu — este placar vale metade.'
       : resta ? `Faltam <b>${resta}</b> pra confirmar. Depois disso ele fecha sozinho valendo metade.`
               : `Confirme até <b>${quando}</b>. Depois disso ele fecha sozinho valendo metade.`)
    : (h <= 0 ? 'O prazo venceu — fecha valendo metade assim que alguém abrir o app.'
       : resta ? `Faltam <b>${resta}</b>. Sem resposta, fecha valendo metade.`
               : `Se não responder até <b>${quando}</b>, fecha sozinho valendo metade.`);
  return `<div style="font-size:11.5px;color:${h<=12?'var(--gold)':'var(--ink3)'};margin-top:7px">${txt}</div>`;
}

/* 16/08 — O CARIMBO. Abrir o app JÁ É ver a pendência: por decisão de 07/08, o
   botão grande da home mostra a ação mais urgente sozinho, e "lançar placar"
   é ela quando existe. Então não é preciso rastrear se a pessoa olhou o card.

   Manda a coluna com qualquer valor: o trigger da mig 34 força `now()` do
   servidor e IGNORA o que vier daqui. Data de presença é prova, e prova que o
   interessado escreve não é prova. Write-once no banco também — reabrir o app
   não empurra o próprio relógio pra frente.

   Erro aqui é silencioso de propósito: o carimbo é uma cortesia com quem
   ainda não viu. Se falhar, a partida cai no teto de 72h, que é a regra de
   antes — nada quebra, ninguém perde nada. */
async function netCarimbarVistas(lista){
  const alvos = (lista||[]).filter(m =>
    m.status === 'pendente' && m.placar_em &&
    !m.visto_por_adversario_em &&
    m.placar_por && m.placar_por !== MEU_UID &&
    (m.criador_id === MEU_UID || m.adversario_id === MEU_UID));
  if(!alvos.length) return;
  try{
    await sb.from('matches')
      .update({ visto_por_adversario_em: new Date().toISOString() })
      .in('id', alvos.map(m => m.id));
    for(const m of alvos) m.visto_por_adversario_em = new Date().toISOString();
  }catch(e){ console.error('[net] carimbo', e); }
}

/* ---- 2d: o W.O. (16/08) ------------------------------------------------
   Partida marcada que ninguém jogou ficava presa PRA SEMPRE: sem os dois
   check-ins o placar não abre, e sem prazo ela não vence. Quem foi à quadra
   ficava com um card zumbi e nenhuma saída.

   Apura na LEITURA, como as 72h e o cinturão — sem agendador. Mas aqui o
   cliente não decide nada: ele só CHAMA. Quem confere o relógio, os check-ins
   e quem paga é a `partida_wo` no banco, porque isto mexe em Pontos de outra
   pessoa e "validação que só existe no cliente é sugestão, não regra".

   O cliente nem tenta adivinhar o resultado: manda e lê o que voltou. */
const _apurandoWO = {};

/* O custo que a ficha MOSTRA. O que VALE é o que o banco gravou — este número
   existe só pra a linha do histórico não ficar muda.
   Reusa o `calcular()` do motor com os dois níveis iguais e derrota: é a mesma
   conta que a `_wo_cobrar` faz lá, e copiar a tabela de bases pra cá criaria a
   segunda verdade que diverge na primeira vez que a de lá mudar. */
function _custoWO(m){
  try{
    const ctx = m.contexto || 'amistoso';
    return calcular(1200, 1200, false, ctx, m.formato, !!m.dupla, false, 0).dPts;
  }catch(e){ return 0; }
}

/* Cancelar é a porta de saída que faltava — sem ela, o único jeito de matar
   uma partida marcada era furando, e a regra do W.O. cobraria por isso.

   O AVISO VEM ANTES. "Regra que só existe no documento não muda
   comportamento": se o custo aparecesse depois do toque, a pessoa descobriria
   a regra sendo multada por ela. O número sai da mesma conta do banco — o
   cliente calcula pra AVISAR, o banco calcula pra VALER. */
async function netCancelarDesafio(matchId){
  const m = _inbox.find(x=>x.id===matchId); if(!m) return;
  const nome0 = _nomeDe(_advId(m)).split(' ')[0];

  if(m.torneio_id){
    if(window.toast) toast('Partida de torneio não se cancela pelo app — quem manda na chave é o dono.');
    return;
  }

  if(m.checkin_criador || m.checkin_adversario){
    if(window.toast) toast('Alguém já assinou presença — esta partida se encerra pelo placar.');
    return;
  }

  const horas = m.quando ? (new Date(m.quando).getTime() - Date.now()) / 3600e3 : null;
  if(horas !== null && horas < 0){
    if(window.toast) toast('O horário já passou — esta partida se encerra sozinha pelo W.O.');
    return;
  }

  const custa = horas !== null && horas < 6;
  // 19/08: o mesmo botão agora também encerra desafio que o outro nem aceitou.
  // "Cancelar o jogo" ali seria mentira — jogo combinado ainda não existe.
  const oQue = m.status === 'desafiado' ? 'o desafio pra' : 'o jogo com';
  const aviso = custa
    ? `Faltam menos de 6h pro jogo com ${nome0}. Cancelar agora custa Pontos, igual a não aparecer — o tempo de ele remarcar a quadra já passou.\n\nCancelar mesmo assim?`
    : `Cancelar ${oQue} ${nome0}? Não custa nada — ainda dá tempo de ele se organizar.`;
  if(!confirm(aviso)) return;

  try{
    const { data, error } = await sb.rpc('desafio_cancelar', { p_match: matchId });
    if(error) throw error;
    if(data && data.custou){
      if(!S.historico) S.historico=[];
      S.historico.unshift({ tipo:'cancelada', euFaltei:true, adv:_advId(m),
        dpts:_custoWO(m), quando:'agora' });
      if(window.salvar) salvar();
    }
    if(window.toast){
      const rotulo = m.status === 'desafiado' ? `Desafio pra ${nome0}` : `Jogo com ${nome0}`;
      toast(data && data.custou
        ? `${rotulo} cancelado — os Pontos foram descontados.`
        : `${rotulo} cancelado. Sem custo.`);
    }
    netAtualizarInbox();
  }catch(e){
    console.error('[net] cancelar', e);
    if(window.toast) toast('Não deu pra cancelar. Tente de novo.');
  }
}

async function netApurarWO(lista){
  const alvos = (lista||[]).filter(m =>
    m.status === 'aceito' && m.quando && !m.torneio_id &&
    // (45/47) mesma razão do `_prazoVencido`: o W.O. encerra a partida, e
    // encerrar é dos capitães. `partida_wo` derivaria o faltante dos dois
    // check-ins, que são deles — o parceiro não tem o que assinar nem apurar.
    !(m.dupla && !_souCapitao(m)) &&
    Date.now() > new Date(m.quando).getTime() + 12*3600e3 &&
    !_apurandoWO[m.id]);
  if(!alvos.length) return 0;

  let fechou = 0;
  for(const m of alvos){
    _apurandoWO[m.id] = 1;
    try{
      const { data, error } = await sb.rpc('partida_wo', { p_match: m.id });
      if(error) throw error;
      if(data && data.wo){
        fechou++;
        const nome0 = _nomeDe(_advId(m)).split(' ')[0];
        // deixa RASTRO na ficha. O débito já saiu do saldo pelo livro-caixa;
        // sem esta linha o jogador vê o número cair e não acha onde.
        if(data.custou && data.faltou === MEU_UID){
          if(!S.historico) S.historico=[];
          S.historico.unshift({ tipo:'wo', euFaltei:true, adv:_advId(m),
            dpts:_custoWO(m), quando:'agora' });
          if(window.salvar) salvar();
        }
        if(window.toast){
          toast(data.ninguem_apareceu
            ? `A partida com ${nome0} passou sem ninguém assinar presença — encerrada, sem custo pra nenhum dos dois.`
            : (data.faltou === MEU_UID
                ? `Você não assinou presença na partida com ${nome0} — ela foi encerrada e os Pontos foram descontados.`
                : `${nome0} não apareceu — a partida foi encerrada. Você não perdeu nada.`));
        }
      }
    }catch(e){ console.error('[net] wo', e); delete _apurandoWO[m.id]; }
  }
  return fechou;
}

async function netApurarPrazos(lista){
  // carimba ANTES de apurar: quem está vendo agora não pode ter o prazo
  // vencido pela leitura que acabou de acontecer.
  await netCarimbarVistas(lista);

  let fechou = 0;
  for(const m of (lista||[])){
    if(!_prazoVencido(m) || _vencendo[m.id]) continue;
    _vencendo[m.id] = 1;
    try{ if(await _fecharPorPrazo(m)) fechou++; }
    catch(e){ console.error('[net] prazo', e); delete _vencendo[m.id]; }
  }
  if(fechou && window.toast){
    toast(`${fechou===1?'Uma partida passou':'Partidas passaram'} do prazo sem confirmação — o placar valeu metade.`);
  }
  return fechou;
}
async function netContestar(matchId){
  const { error } = await sb.from('matches').update({ status:'contestada' }).eq('id',matchId);
  if(error){ alert('Erro: '+error.message); return; }
  if(window.toast) toast('Placar contestado. Conversem e lancem de novo.');
  netAtualizarInbox();
}

/* ---- UI: caixa de partidas (bottom sheet) ----------------------------- */
function netFecharOnline(){ _on=null; const el=document.getElementById('net-online'); if(el) el.remove(); }
function netFecharInbox(){ const el=document.getElementById('net-inbox'); if(el) el.remove(); }

const _wrap = (inner)=>`<div style="width:100%;max-width:460px;background:var(--sup);border:1px solid var(--linha);
    border-radius:20px 20px 0 0;padding:20px 18px calc(20px + env(safe-area-inset-bottom));color:var(--ink);
    font-family:system-ui,sans-serif;max-height:82vh;overflow:auto">${inner}</div>`;
/* `extra` (13/08) sobrescreve o flex pra um botão ocupar a linha inteira —
   é o que separa "Propor outro dia" da dupla Recusar/Aceitar sem espremer
   três rótulos numa fileira só. */
const _btn = (txt,onclick,tipo,extra)=>`<button onclick="${onclick}" style="flex:1;padding:13px;border-radius:12px;
    border:1px solid var(--linha2);font:600 14px system-ui;cursor:pointer;
    background:${tipo==='ok'?'#2C5A00':tipo==='no'?'var(--dn-bg)':'var(--sup2)'};color:#fff;${extra||''}">${txt}</button>`;
const _sheet = (id, inner)=>{
  let el=document.getElementById(id);
  if(!el){ el=document.createElement('div'); el.id=id;
    el.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(10,7,5,.72);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(3px)';
    el.onclick=(e)=>{ if(e.target===el){ if(id==='net-online') _on=null; el.remove(); } };
    document.body.appendChild(el);
  }
  el.innerHTML=_wrap(inner);
  return el;
};

function netAbrirInbox(){ _fbPend=null; _fbAberto=null; netRenderInbox(); }
/* "🗓 sáb 15/08 · 19h" + "📍 Clube Bahiano de Tênis · Quadra 3 — endereço" —
   informação, não campo (11/08): as linhas só aparecem quando a partida tem.
   Data ABSOLUTA, não contagem: "faltam 2 dias" mente nas bordas (o floor e o
   ceil erram de jeitos diferentes); a data não mente nunca. */
/* `pref` (13/08, migração 25): as mesmas quatro informações existem em duas
   versões na linha — o COMBINADO (`quando`, `local_id`, `quadra`, `quadra_por`)
   e a PROPOSTA na mesa (`prop_*`). Um render só pros dois, porque o que a
   contraproposta pede é justamente pôr um do lado do outro: quem compara
   "estava assim / passa a ser" não pode estar lendo dois formatos diferentes. */
const _pinDe = (m, pref='')=>{
  const F = (c)=> m[pref+c];
  let h='';
  const quando = F('quando');
  if(quando){
    const d=new Date(quando), p=(n)=>String(n).padStart(2,'0');
    const dias=['dom','seg','ter','qua','qui','sex','sáb'];
    h+=`<div style="font-size:11.5px;color:var(--ink2);margin-top:6px">🗓 ${dias[d.getDay()]} ${p(d.getDate())}/${p(d.getMonth()+1)} · ${d.getHours()}h${d.getMinutes()?p(d.getMinutes()):''}</div>`;
  }
  const l = F('local_id') && _locDe(F('local_id'));
  if(l) h+=`<div style="font-size:11.5px;color:var(--ink2);margin-top:${quando?'3px':'6px'}">📍 ${l.nome}${F('quadra')?' · Quadra '+F('quadra'):''}${l.endereco?`<span style="color:var(--ink3)"> — ${l.endereco}</span>`:''}</div>`;
  /* 18/08: a partida TEM lugar marcado e o cache não sabe o nome dele. Antes
     isto caía no vazio e o card mentia por omissão — quem lia achava que o
     desafio veio sem local. O número da quadra ainda é verdade e vai junto:
     é a parte do combinado que não depende de resolver o nome do clube. */
  else if(F('local_id')) h+=`<div style="font-size:11.5px;color:var(--ink3);margin-top:${quando?'3px':'6px'}">📍 Lugar marcado${F('quadra')?' · Quadra '+F('quadra'):''} — o nome do clube não carregou</div>`;
  /* Os dois combinados de responsabilidade, cada um com o SEU verbo: quadra se
     reserva, bola se leva — ninguém carrega uma quadra. São fatos separados
     de propósito (colunas separadas, mig 27) porque caem em pessoas
     diferentes: no clube a quadra já costuma estar reservada e mesmo assim
     alguém tem que levar bola.
     Escritos na 2ª pessoa quando sou eu: a obrigação é minha, e "Você leva a
     bola" cobra melhor que o meu próprio nome escrito na tela. */
  const linha = (txt)=>{ h+=`<div style="font-size:11.5px;color:var(--ink2);margin-top:${h?'3px':'6px'}">${txt}</div>`; };
  const qp = F('quadra_por');
  if(qp) linha(`🏟 ${qp===MEU_UID?'<b>Você reserva</b> a quadra':_nomeDe(qp).split(' ')[0]+' reserva a quadra'}`);
  const bp = F('bola_por');
  if(bp) linha(`🎾 ${bp===MEU_UID?'<b>Você leva</b> a bola':_nomeDe(bp).split(' ')[0]+' leva a bola'}`);
  /* segue devolvendo vazio quando não há nada: este render também roda no card
     de placar já lançado, e "a combinar" numa partida que já aconteceu é ruído.
     Quem precisa do texto do vazio é a contraproposta, que pede o dito lá. */
  return h;
};
const _pinOuVazio = (m, pref='')=> _pinDe(m, pref)
  || `<div style="font-size:11.5px;color:var(--ink3);margin-top:6px">a combinar</div>`;

/* As três condições que `contraproposta_por` levanta exceção — repetidas aqui
   só pra ESCONDER o botão, não pra validar: quem valida é a função. O teto de
   3 é dela; `prop_rodadas` nulo em linha velha conta como zero. */
const _podeContrapor = (m)=> m.status==='desafiado'
  && (m.prop_rodadas||0) < 3
  && m.prop_por !== MEU_UID;

/* 19/08 — as condições da `desafio_cancelar` (mig 36) repetidas aqui, pela
   mesma razão do `_podeContrapor`: ESCONDER o botão, não validar. Quem valida
   é a função. Estavam soltas dentro do ramo 'aceito' e por isso não valiam
   pros ramos de 'desafiado' — o criador de um desafio ainda não aceito não
   tinha saída nenhuma na tela, embora o banco aceitasse desde a 36. Era a
   fechadura provada sem botão, e é o que impedia apagar quadra com desafio
   pendente.

   ⚠️ `torneio_id` entra aqui e não estava no ramo 'aceito': o inbox (l. 524)
   não filtra partida de torneio, e a função recusa por escrito — "quem manda
   na chave é o dono". O botão aparecia e só devolvia erro. Botão que não
   funciona não é oferta (a mesma regra que já governa o "Recusar"). */
const _podeCancelar = (m)=>
     (m.status==='desafiado' || m.status==='aceito')
  && !m.torneio_id
  && !m.checkin_criador && !m.checkin_adversario
  && (!m.quando || new Date(m.quando) > new Date());

/* ---- presença (mig 25) ------------------------------------------------
   Qual das duas colunas é minha depende de que lado da partida eu sou. O
   banco defende o resto: a trava (7) do trigger força o valor a `now()`,
   recusa reescrita e proíbe assinar a do outro — o cliente só oferece. */
const _meuCheckin   = (m)=> _souCriador(m) ? m.checkin_criador    : m.checkin_adversario;
const _outroCheckin = (m)=> _souCriador(m) ? m.checkin_adversario : m.checkin_criador;
const _checkinDe = (m)=>{
  const meu=_meuCheckin(m), dele=_outroCheckin(m);
  if(!meu && !dele) return '';
  const nome0=_nomeDe(_advId(m)).split(' ')[0];
  const [cor,txt] = (meu && dele) ? ['var(--up)', `✅ Vocês dois estão na quadra`]
                  : meu           ? ['var(--ink2)', `✅ Você fez check-in — falta ${nome0}`]
                  :                 ['var(--ink2)', `✅ ${nome0} já está na quadra`];
  return `<div style="font-size:11.5px;color:${cor};margin-top:6px">${txt}</div>`;
};
function netRenderInbox(){
  const linhas = _inbox.map(m=>{
    const outro=_nomeDe(_advId(m)).split(' ')[0];
    let txt='', acoes='';
    /* `&& !m.prop_por` é o que faz este ramo NÃO engolir a contraproposta.
       Sem ele, o caso "eu propus → ele contrapropôs → é minha vez" caía aqui
       (sou o adversário, afinal) e eu via o desafio ORIGINAL, sem sinal de que
       havia proposta na mesa. Pior: o "Aceitar" daqui é `netAceitar`, um update
       cru pra 'aceito' — a trava (4) deixa passar porque sou mesmo o
       adversário, e o combinado velho valeria com a proposta descartada em
       silêncio e os `prop_*` sujos numa partida já aceita. Proposta na mesa
       sempre manda no card. */
    /* (45/47) DUPLAS MANDA NO CARD, pela mesma razão da contraproposta: quem
       é parceiro não é adversário, e cair nos ramos de baixo mostraria a ele
       um desafio que não é dele, com botões que a trava (19) recusa. Três
       estados, nesta ordem: eu devo o aceite · eu já aceitei · a partida andou
       e eu só acompanho. */
    if(m.dupla && !_souCapitao(m)){
      const meuLado = m.parceiro_criador_id===MEU_UID ? 'criador' : 'adversario';
      const capitao = _nomeDe(meuLado==='criador' ? m.criador_id : m.adversario_id).split(' ')[0];
      const advCap  = _nomeDe(meuLado==='criador' ? m.adversario_id : m.criador_id).split(' ')[0];
      const advPar  = _nomeDe(meuLado==='criador' ? m.parceiro_adversario_id : m.parceiro_criador_id).split(' ')[0];
      const dupla   = `<div style="font-size:12.5px;color:var(--ink2);margin-top:7px">Você e <b style="color:var(--ink)">${capitao}</b> contra <b style="color:var(--ink)">${advCap}</b> e <b style="color:var(--ink)">${advPar}</b></div>`;
      if(_meuAceitePendente(m)){
        txt=`<div style="font-size:14px"><b>${capitao}</b> te chamou pra jogar de <b>duplas</b></div>${dupla}${_pinDe(m)}`
          + `<div style="font-size:11.5px;color:var(--ink3);margin-top:7px">Os quatro precisam topar pra o desafio valer. Recusar não custa nada.</div>`;
        acoes=`${_btn('Recusar',`_net.recusar('${m.id}')`,'no')}${_btn('Topar',`_net.aceitarParceiro('${m.id}')`,'ok')}`;
      } else if(m.status==='desafiado'){
        const falta = (meuLado==='criador') ? !m.aceite_parceiro_adversario : !m.aceite_parceiro_criador;
        txt=`Você topou a duplas com <b>${capitao}</b>${dupla}`
          + `<div style="font-size:11.5px;color:var(--ink3);margin-top:7px">${falta
              ? `Falta <b>${advPar}</b> responder — depois é com ${advCap} fechar.`
              : `Agora é com <b>${advCap}</b> fechar o desafio.`}</div>`;
        acoes='';
      } else {
        /* Partida viva ou aguardando placar. O parceiro não lança nem confirma
           (trava 19) — o card existe pra ele saber onde e quando é o jogo, que
           é o que ele precisa. Botão que o banco recusaria não é oferta. */
        const estado = m.status==='aceito' ? 'Jogo confirmado'
                     : m.status==='pendente' ? `${advCap} lançou o placar — os capitães confirmam`
                     : 'Partida encerrada';
        txt=`<b>${estado}</b>${dupla}${_pinDe(m)}`;
        acoes='';
      }
    } else if(m.status==='desafiado' && m.adversario_id===MEU_UID && !m.prop_por){
      const uid=_advId(m); const j=S.jogadores[_chaveLocal(uid)]||{nome:outro};
      const amigo=netEhAmigo(uid);
      const divTxt=(window.divisaoDe&&j.nivel!=null)?('Classe '+divisaoDe(j.nivel)):'';
      txt=`<div style="display:flex;align-items:center;gap:11px;margin-bottom:8px">
        ${window.avatar?avatar(uid):''}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700">${j.nome} <span style="font-weight:400;color:var(--ink3);font-size:11px">${netId(uid)}</span></div>
          <div style="font-size:11px;color:var(--ink2)">${divTxt}${divTxt?' · ':''}${amigo?'<span style="color:var(--up)">✔ seu amigo</span>':'não é seu amigo'}</div>
        </div>
      </div>
      <div style="font-size:14px"><b>${j.nome.split(' ')[0]}</b> te desafiou pra uma partida</div>
      ${_pinDe(m)}
      <!-- 11/08: regra que só existe no documento não muda comportamento. A
           decisão "recusar não custa fair play" existia desde o protótipo do
           radar e nunca chegou à tela — e quem não sabe que é de graça acaba
           aceitando jogo que não quer, ou some sem responder. -->
      <div style="font-size:11.5px;color:var(--ink3);margin-top:7px">Recusar não custa nada — não mexe no seu nível nem na sua reputação.</div>`;
      acoes=`${_podeContrapor(m)?_btn('Propor outro dia',`_net.abrirContra('${m.id}')`,null,'flex:1 0 100%'):''}${_btn('Recusar',`_net.recusar('${m.id}')`,'no')}${_btn('Aceitar',`_net.aceitar('${m.id}')`,'ok')}`;
    /* 13/08 (mig 25): a contraproposta inverte de quem é a vez, e o criador —
       que antes só esperava — passa a ter o que responder. Por isso estes dois
       ramos vêm ANTES do "aguardando": quem tem proposta na mesa não está
       aguardando nada. */
    } else if(m.status==='desafiado' && m.prop_por && m.prop_por!==MEU_UID){
      txt=`<b>${outro}</b> quer jogar em outro dia ou lugar`
        + `<div style="font-size:11px;color:var(--ink3);margin-top:9px;text-transform:uppercase;letter-spacing:.06em">Estava assim</div>`
        + `<div style="opacity:.55">${_pinOuVazio(m)}</div>`
        + `<div style="font-size:11px;color:var(--gold);margin-top:9px;text-transform:uppercase;letter-spacing:.06em">Passa a ser</div>`
        + _pinOuVazio(m,'prop_')
        + (m.prop_rodadas>=3?`<div style="font-size:11.5px;color:var(--ink3);margin-top:9px">Já foram três idas e voltas — agora é aceitar ou deixar pra lá.</div>`:'');
      /* Recusar só aparece pra quem RECEBEU o desafio: a trava (4) do trigger
         só deixa o adversário pôr 'recusado'. Do lado do criador o botão só
         devolveria erro, e botão que não funciona não é oferta. */
      acoes=`${_podeContrapor(m)?_btn('Propor outro',`_net.abrirContra('${m.id}')`,null,'flex:1 0 100%'):''}`
        + `${m.adversario_id===MEU_UID?_btn('Recusar',`_net.recusar('${m.id}')`,'no'):''}`
        + `${_btn('Aceitar',`_net.aceitarContra('${m.id}')`,'ok')}`;
    } else if(m.status==='desafiado' && m.prop_por===MEU_UID){
      txt=`Você propôs outro combinado pra <b>${outro}</b> — falta ele responder`
        + _pinOuVazio(m,'prop_');
      /* Cancelar só do lado do CRIADOR. O banco deixa qualquer um dos dois
         cancelar, mas quem recebeu o desafio tem "Recusar", que é de graça
         por desenho — oferecer a ele o cancelamento seria oferecer o caminho
         que pode custar Pontos (menos de 6h) tendo um gratuito ao lado.
         ⚠️ Sobra o caso do adversário que contrapropôs: ele fica sem botão
         nenhum neste ramo. O certo pra ele é "Recusar", não cancelar. */
      acoes=`${(_souCriador(m) && _podeCancelar(m))
              ? _btn('Cancelar o desafio',`_net.cancelarDesafio('${m.id}')`,'no') : ''}`;
    } else if(m.status==='desafiado'){
      // só o criador cai aqui: os outros três ramos já pegaram o adversário
      txt=`Aguardando <b>${outro}</b> aceitar seu desafio` + _pinDe(m);
      acoes=`${_podeCancelar(m)
              ? _btn('Cancelar o desafio',`_net.cancelarDesafio('${m.id}')`,'no') : ''}`;
    } else if(m.status==='aceito'){
      /* 16/08: o placar só existe depois que OS DOIS assinaram presença.
         Antes, "Lançar placar" aparecia junto com "Cheguei" e não exigia nada —
         dava pra lançar placar de partida que ninguém foi jogar, e se o outro
         não respondesse em 72h o resultado fechava sozinho valendo metade. O
         check-in dos dois é o que faz o placar pressupor um jogo.

         ⚠️ 16/08 — ESTE TEXTO MUDOU, E A LIÇÃO É CARA. Até a 34, o check-in só
         abria o placar: não assinar não custava nada, e a tela prometia por
         escrito "não tem prazo, dá pra assinar depois do jogo". A 35 pendurou
         o W.O. no MESMO botão sem reler a garantia — e aí a promessa virou
         armadilha: os dois jogam de verdade, um assina, o outro não porque o
         app disse que dava tempo, e 12h depois ele paga e a partida some sem
         que o jogo possa ser registrado.

         Ainda dá pra assinar depois (a trava 7 não tem prazo, e isso continua
         sendo o desenho — "esqueci de tocar num botão" não pode virar "a
         partida não existiu"). O que passou a ter prazo é o efeito: assinar
         depois de 12h do horário destrava o placar mas não conta mais como
         presença. A tela precisa dizer as duas coisas.

         Regra nova em cima de tela velha é o defeito de sempre: "vocabulário
         revogado sobrevive na tela depois de morrer na decisão". */
      const faltaMim   = !_meuCheckin(m);
      const faltaOutro = !_outroCheckin(m);
      const passouJanela = m.quando && Date.now() > new Date(m.quando).getTime() + 12*3600e3;
      txt=`Partida marcada com <b>${outro}</b>` + _pinDe(m) + _checkinDe(m)
        + (faltaMim||faltaOutro
            ? `<div style="font-size:11px;color:var(--ink3);margin-top:7px;line-height:1.45">O placar abre quando os dois tocarem em <b>Cheguei</b>${
                faltaMim && faltaOutro ? ' — falta você e ' + outro
                : faltaMim ? ' — falta você' : ' — falta ' + outro}. ${
                passouJanela
                  ? 'Ainda dá pra assinar e lançar o placar, mas a janela de presença já fechou.'
                  : '<b style="color:var(--dn)">Assine até 12h depois do horário</b> — passou disso, quem não assinou conta como falta.'}</div>`
            : '');
      /* "Cheguei" só enquanto eu não assinei: o check-in não se desfaz (trava 7),
         então oferecer de novo é oferecer um erro.

         "Cancelar" só enquanto NINGUÉM assinou e o horário não passou — são as
         mesmas duas condições que a `desafio_cancelar` exige no banco. Oferecer
         o botão fora delas seria oferecer um erro, e depois do horário quem
         encerra é o relógio do W.O., não o botão. */
      acoes=`${faltaMim?_btn('Cheguei',`_net.checkin('${m.id}')`):''}`
        + `${(!faltaMim && !faltaOutro)?_btn('Lançar placar',`_net.lancar('${m.id}')`,'ok'):''}`
        + `${(faltaMim && faltaOutro && _podeCancelar(m))
              ? _btn('Cancelar',`_net.cancelarDesafio('${m.id}')`,'no') : ''}`;
    } else if(m.status==='pendente' && m.placar_por!==MEU_UID){
      const euVenci = _souCriador(m) ? m.venceu_criador : !m.venceu_criador;
      const meuPl = _souCriador(m) ? m.placar : _inverter(m.placar);
      // partida lançada na mão carrega a procedência na cara — quem confirma
      // tem que saber que ela veio de fora do app
      txt=`${m.origem==='mao'?'<span style="display:inline-block;padding:2px 7px;border-radius:7px;background:var(--sup2);color:var(--gold);font-size:10px;font-weight:700;margin-bottom:6px">LANÇADA NA MÃO</span><br>':''}`
         +`<b>${outro}</b> lançou o placar: você <b style="color:${euVenci?'var(--up)':'var(--dn)'}">${euVenci?'venceu':'perdeu'}</b> ${meuPl}`
         + _pinDe(m)
         + _avisoPrazo(m, 'confirmar');
      acoes=`${_btn('Contestar',`_net.contestar('${m.id}')`,'no')}${_btn('Confirmar',`_net.confirmar('${m.id}')`,'ok')}`;
    } else if(m.status==='pendente'){
      txt=`Aguardando <b>${outro}</b> confirmar o placar` + _avisoPrazo(m, 'esperar');
    /* CONTESTADA (20/08) — o estado que não tinha card e por isso não tinha saída.
       Fica VISÍVEL como contestada em vez de voltar pra 'aceito': houve uma
       discordância, e apagar esse registro seria apagar o fato. É o mesmo
       princípio do W.O. e do cancelamento — quem discordou fica escrito.
       Relançar é dos CAPITÃES (trava 19); o parceiro cai no ramo de duplas
       lá em cima e vê o estado sem botão. */
    } else if(m.status==='contestada'){
      const meuPl = _souCriador(m) ? m.placar : _inverter(m.placar);
      const euContestei = m.placar_por === MEU_UID;   // quem lançou é quem foi contestado
      txt=`<span style="display:inline-block;padding:2px 7px;border-radius:7px;background:var(--sup2);color:var(--dn);font-size:10px;font-weight:700;margin-bottom:6px">PLACAR CONTESTADO</span><br>`
        + (euContestei
            ? `<b>${outro}</b> não concordou com o placar que você lançou (${meuPl})`
            : `Você não concordou com o placar que <b>${outro}</b> lançou (${meuPl})`)
        + _pinDe(m)
        + `<div style="font-size:11.5px;color:var(--ink3);margin-top:7px">Combinem o placar certo e lancem de novo — qualquer um dos dois pode. Nada foi para o ranking: a partida não valeu nada até vocês concordarem.</div>`;
      acoes=`${_btn('Lançar de novo',`_net.lancar('${m.id}')`,'ok')}`;
    }
    /* 18/08 (mig 40): a conversa da partida. Em todo card vivo — desafiado,
       aceito, pendente — porque é nesses que existe o que combinar. É de
       contorno e ao lado das ações, não entre elas: falar não é decidir. */
    /* 'contestada' entra (20/08, com a mig 49): é o estado em que conversar é o
       ÚNICO caminho de saída — o card manda combinar o placar certo, e a
       policy `partida_msg_ins` passou a aceitar mensagem nesse status. As duas
       coisas andam juntas: botão sem policy é recado que morre em 42501. */
    const viva = ['desafiado','aceito','pendente','contestada'].includes(m.status);
    // (51) recado não lido acende o botão — número aqui pode, é contagem de sala
    const nrp = netRecadosDe('partida', m.id);
    const conversar = viva ? `<button onclick="_net.abrirChatPartida('${m.id}')" title="conversar" style="flex:0 0 auto;padding:11px 13px;border-radius:12px;border:1px solid ${nrp?'var(--up)':'var(--linha2)'};background:none;color:${nrp?'var(--up)':'var(--ink2)'};font:600 13px system-ui;cursor:pointer">💬${nrp?` ${nrp}`:''}</button>` : '';
    return `<div style="border:1px solid var(--linha);border-radius:14px;padding:14px;margin-top:10px">
      <div style="font-size:14px;margin-bottom:${(acoes||conversar)?'12px':'0'}">${txt}</div>
      ${(acoes||conversar)?`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">${acoes}${conversar}</div>`:''}</div>`;
  }).join('') || `<p style="color:var(--ink2);font-size:13px;margin-top:8px">Nenhuma partida rolando. Vá no Radar e desafie alguém.</p>`;
  /* 13/08: pedidos de amizade entram AQUI, não numa tela própria. Esta caixa já
     é o lugar do "isto espera a sua resposta" — desafio, placar pra confirmar —
     e pedido de amizade é da mesma natureza. Superfície nova só se o objeto for
     de outra natureza; este não é. Forma copiada dos pedidos de grupo.
     Sem avatar de propósito: o render é síncrono e quem pediu pode não estar em
     `S.jogadores` ainda — o disco com a cor não depende de carregar nada. */
  const _peds = (window.netPedidosAmizade ? netPedidosAmizade() : []);
  const pedidosH = !_peds.length ? '' :
    `<div style="font:700 12px system-ui;color:var(--gold);margin:16px 0 2px;text-transform:uppercase;letter-spacing:.08em">Pedidos de amizade</div>`
    + _peds.map(p=>`<div style="display:flex;align-items:center;gap:9px;padding:10px 0;border-bottom:1px solid var(--sup2)">
        ${_discoUid(p.de, 28)}
        <div style="flex:1;min-width:0">
          <b>${_nomeDe(p.de)}</b> <span style="color:var(--ink3);font-size:11px">${netId(p.de)}</span>
          <div style="font-size:11px;color:var(--ink2)">quer ser seu amigo — amigos se desafiam em qualquer classe</div>
        </div>
        <button onclick="_net.recusarAmizade('${p.de}')" style="padding:7px 11px;border-radius:9px;border:1px solid var(--dn-bg);background:var(--dn-bg);color:#fff;font:600 12px system-ui;cursor:pointer">Recusar</button>
        <button onclick="_net.aceitarAmizade('${p.de}')" style="padding:7px 11px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Aceitar</button>
      </div>`).join('');

  _sheet('net-inbox', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Suas partidas</div>
      <button onclick="_net.fecharInbox()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button>
    </div>${pedidosH}${linhas}${_fbSecao()}`);
}

/* =========================================================================
   25/08 (mig 59) — "COMO FOI?" · o feedback de encontro

   O pedido do Rege: "eu só preciso depois ter uma informação aqui se deu match
   ou não deu... isso na camada de dados vai me ajudar a entender quem são os
   caras que realmente têm lugar com acesso e quem não tem tanto."

   NÃO REABRE O EXPLOIT DE 16/08 (declarar presença do outro), e a razão é
   estrutural, não de tela: a resposta não move Nível, não move Pontos, não
   abre nem fecha placar e não gera W.O. Resposta que não paga nem cobra nada
   não compra nada pra quem mente. Nenhuma opção tem o outro como sujeito, e
   ninguém lê a resposta de ninguém (a policy de select é `player_id = uid`).

   PRECEDÊNCIA: o card vive ABAIXO das partidas em aberto. Nunca ao lado da
   oferta de cancelar — perguntar "como foi?" no mesmo lugar em que se resolve
   uma partida que ainda não aconteceu é confundir as duas coisas.
   ========================================================================= */
let _fbPend = null;          // null = nunca carregou

async function netFeedbackCarregar(){
  if(!MEU_UID) return [];
  const desde = new Date(Date.now() - 30*86400e3).toISOString();
  const [ms, fb] = await Promise.all([
    sb.from('matches')
      .select('id, quando, criador_id, adversario_id, parceiro_criador_id, parceiro_adversario_id, status, local_id, quadra_por')
      .or(`criador_id.eq.${MEU_UID},adversario_id.eq.${MEU_UID},`
        + `parceiro_criador_id.eq.${MEU_UID},parceiro_adversario_id.eq.${MEU_UID}`)
      .in('status',['aceito','pendente','confirmada','contestada'])
      .lt('quando', new Date().toISOString())
      .gt('quando', desde)
      .order('quando',{ascending:false}),
    sb.from('match_feedback').select('match_id').eq('player_id', MEU_UID),
  ]);
  if(ms.error){ console.error('[net] feedback matches', ms.error); return []; }
  /* Erro ao ler as MINHAS respostas não pode virar "não respondeu": perguntar
     de novo o que a pessoa já respondeu é o jeito mais rápido de ensinar que
     o card é ruído. Na dúvida, não pergunta. */
  if(fb.error){ console.error('[net] feedback lidos', fb.error); return []; }
  const jaRespondi = new Set((fb.data||[]).map(x=>x.match_id));
  _fbPend = (ms.data||[]).filter(m=> !jaRespondi.has(m.id));
  return _fbPend;
}

async function netFeedbackResponder(matchId, jogou, extra){
  if(!MEU_UID) return;
  const linha = { match_id: matchId, player_id: MEU_UID, jogou };
  if(extra && extra.motivo) linha.motivo = extra.motivo;
  if(extra && extra.quadra) linha.quadra = extra.quadra;
  const { error } = await sb.from('match_feedback').upsert(linha);
  if(error){ alert('Não deu pra registrar: '+error.message); return; }
  if(_fbPend) _fbPend = _fbPend.filter(m=> m.id !== matchId);
  if(window.toast) toast('Obrigado — isso ajuda a gente a entender onde dá pra jogar.');
  netRenderInbox();
}

/* Segundo passo: só aparece pra quem disse NÃO, e só pergunta POR QUÊ.
   Nenhuma opção aponta pra outra pessoa — "não combinamos" tem o par como
   sujeito, nunca o outro. */
const _FB_MOTIVOS = [
  ['quadra',         'Não consegui quadra'],
  ['chuva',          'Choveu / tempo'],
  ['nao_combinamos', 'A gente não fechou horário'],
  ['outro',          'Outro motivo'],
];

function _fbCard(m){
  const adv = (typeof _advId==='function') ? _advId(m) : null;
  const nome = adv ? _nomeDe(adv) : 'seu adversário';
  const quando = m.quando ? new Date(m.quando).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) : '';
  const bt=(t,js,cor)=>`<button onclick="${js}" style="flex:1;padding:11px 8px;border-radius:12px;cursor:pointer;font:700 13px system-ui;border:1px solid ${cor||'var(--linha2)'};background:${cor?'rgba(131,224,0,.12)':'var(--sup)'};color:${cor||'var(--ink)'}">${t}</button>`;
  const motivos = _FB_MOTIVOS.map(([v,t])=>
    `<button onclick="_net.fbResponder('${m.id}','nao',{motivo:'${v}'})" style="width:100%;text-align:left;padding:10px 12px;border-radius:11px;border:1px solid var(--linha2);background:var(--sup);color:var(--ink);font:500 12.5px system-ui;cursor:pointer;margin-top:6px">${t}</button>`).join('');
  const aberto = _fbAberto === m.id;
  return `<div style="background:var(--sup);border:1px solid var(--linha);border-radius:14px;padding:13px;margin-top:9px">
      <div style="font:700 13.5px system-ui">O jogo com ${nome} aconteceu?</div>
      <div style="font-size:11.5px;color:var(--ink3);margin-top:3px">Estava marcado pra ${quando}. Isso não mexe em nada do seu ranking — é só pra gente saber onde dá pra jogar de verdade.</div>
      ${aberto
        ? `<div style="margin-top:10px"><div style="font-size:11px;color:var(--ink3)">O que atrapalhou?</div>${motivos}</div>`
        : `<div style="display:flex;gap:8px;margin-top:11px">
             ${bt('Não rolou',`_net.fbAbrir('${m.id}')`)}
             ${bt('Jogamos','_net.fbResponder(\''+m.id+'\',\'sim\')','var(--up)')}
           </div>`}
    </div>`;
}

let _fbAberto = null;
function _fbAbrir(id){ _fbAberto = id; netRenderInbox(); }

function _fbSecao(){
  if(_fbPend === null){                       // carga lazy, uma vez por abertura
    _fbPend = [];
    netFeedbackCarregar().then(()=>{ if(document.getElementById('net-inbox')) netRenderInbox(); });
    return '';
  }
  if(!_fbPend.length) return '';
  /* NO MÁXIMO UM POR VEZ. Três cards de "como foi?" empilhados viram
     formulário, e formulário na caixa de recados ninguém responde. */
  return `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--linha)">
      <div style="font:700 10px system-ui;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3)">Como foi?</div>
      ${_fbCard(_fbPend[0])}
    </div>`;
}

/* ---- UI: desafio + lançar placar (overlay _on) ------------------------ */
function _onDigitou(v){ _on.placarTxt=v; _on.sets=netParsePlacar(v); netRenderOnline(); }

/* 16/08: os placares prontos.
   Digitar "6-3 6-4" num teclado de celular, de pé na quadra, suado, é o ponto
   mais frágil do ciclo — e o registro é o elo frágil por definição. Toque
   substitui digitação nos casos que cobrem quase tudo: em tênis, set que
   termina fora do tie-break só pode acabar em 6-0 a 6-4, 7-5 ou 7-6.

   O campo de texto CONTINUA valendo e não vira somente-leitura: existe 8-6 em
   set longo, existe super tie-break, existe o placar que o app não previu.
   Botão que substitui o teclado ajuda; botão que confisca o teclado atrapalha
   justamente no caso raro, que é quando a pessoa mais precisa. */
const _PLACARES = ['6-0','6-1','6-2','6-3','6-4','7-5','7-6'];

function _addSet(s){
  const atual = (_on.placarTxt||'').trim();
  _onDigitou(atual ? atual + ' ' + s : s);
}
function _tiraSet(){
  const p = (_on.placarTxt||'').trim().split(/\s+/).filter(Boolean);
  p.pop();
  _onDigitou(p.join(' '));
}

/* Uma linha de botões. `inverte` troca os lados: a mesma lista serve pro set
   ganho e pro perdido, porque "seus games primeiro" é a única convenção que a
   tela promete e ela não muda. */
function _linhaPlacares(rotulo, inverte){
  const bts = _PLACARES.map(s=>{
    const [a,b] = s.split('-');
    const v = inverte ? `${b}-${a}` : s;
    return `<button onclick="_net.addSet('${v}')" style="flex:1;min-width:0;padding:9px 0;border-radius:9px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:700 12px system-ui;cursor:pointer">${v}</button>`;
  }).join('');
  return `<div style="font-size:11px;color:var(--ink2);margin:10px 0 5px">${rotulo}</div>
    <div style="display:flex;gap:5px">${bts}</div>`;
}
function netRenderOnline(){
  let body='';
  /* 13/08 (mig 25): a contraproposta divide esta folha com o desafio em vez de
     ganhar uma própria. São os mesmos quatro campos combinados — quem propõe
     outro dia está respondendo o mesmo formulário, só que já preenchido. Muda
     o título, o texto e o botão; o corpo é o mesmo. */
  if(_on.step==='desafio' || _on.step==='contra'){
    const ehContra = _on.step==='contra';
    /* 🗓 quando: dia e hora são a primeira coisa que dois jogadores combinam.
       16/08 — VIROU OBRIGATÓRIO. Reverte 11/08c, e a razão que parecia óbvia
       ("a combinar não vira jogo") é falsa: o card de 'aceito' abre "Cheguei"
       → "Lançar placar" sem olhar a data uma vez. A razão que vale é outra —
       partida sem horário é a única coisa no app que não morre sozinha, e
       agora existem dois relógios pendurados nele (o W.O. de 12h e o
       vencimento do placar).

       O atrito é quase nada porque os atalhos respondem por quase todo caso:
       obrigatório aqui é tocar num chip, não digitar do zero.

       value= preenchido de volta: trocar o local re-renderiza o sheet, e um
       input vazio com _on.quando cheio seria estado invisível — bug fantasma */
    const _p2=(n)=>String(n).padStart(2,'0');
    const _fmtLocal=(d)=>`${d.getFullYear()}-${_p2(d.getMonth()+1)}-${_p2(d.getDate())}T${_p2(d.getHours())}:${_p2(d.getMinutes())}`;
    const qv = _on.quando ? _fmtLocal(new Date(_on.quando)) : '';
    // min/max espelham as travas do banco: piso de agora (mig 35) e teto de
    // 90 dias (mig 34). A tela avisa antes; o banco é quem garante.
    const agora = new Date();
    const teto  = new Date(agora.getTime() + 90*864e5);
    const atalhos = _atalhosQuando().map(a=>`
      <button type="button" onclick="_net.onQuandoAtalho('${_fmtLocal(a.d)}')"
        style="flex:1;padding:9px 6px;border-radius:10px;font:600 12px system-ui;cursor:pointer;
               border:1px solid ${qv===_fmtLocal(a.d)?'var(--lime)':'var(--linha2)'};
               background:${qv===_fmtLocal(a.d)?'rgba(131,224,0,.12)':'transparent'};
               color:${qv===_fmtLocal(a.d)?'var(--lime)':'var(--ink2)'}">${a.rot}</button>`).join('');
    /* (45) SIMPLES × DUPLAS. Só na criação — a trava (2) congela `dupla` no
       UPDATE, então a contraproposta NÃO oferece o toggle: mudar o formato de
       um desafio que já existe é outro desafio. Em duplas, dois seletores:
       o meu parceiro e o do adversário. Quem desafia nomeia os quatro (15a) —
       é assim que o convite chega aos outros três, e é o que faz a partida
       nascer completa em vez de virar um objeto pela metade esperando gente. */
    const duplaH = ehContra ? '' : _duplaBloco((_on.adv.nome||'').split(' ')[0]);
    const qdoH = `
      ${duplaH}
      <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">🗓 Quando ${qv?'':'<span style="color:var(--dn)">— escolha o dia e a hora</span>'}</div>
      <div style="display:flex;gap:6px;margin-bottom:8px">${atalhos}</div>
      <input type="datetime-local" value="${qv}" onchange="_net.onQuando(this.value)"
        min="${_fmtLocal(agora)}" max="${_fmtLocal(teto)}"
        style="width:100%;padding:12px;border-radius:12px;background:var(--bg);color:#fff;font:600 14px system-ui;color-scheme:dark;
               border:1px solid ${qv?'var(--linha2)':'var(--dn)'}"/>
      <div style="height:12px"></div>`;
    // 📍 da partida: nasce com o local principal do desafiante, dá pra trocar
    // ou tirar. A quadra é opcional e limitada ao nº real de quadras do local.
    const ls=_locaisMarcaveis(); const lSel=_locDe(_on.localId);   // clube do ADM + as minhas quadras
    /* Os dois combinados de responsabilidade (mig 27). Um par de botões cada,
       porque os dois valores possíveis são os dois jogadores — é o que as
       constraints `matches_quadra_por_participa` e `matches_bola_por_participa`
       aceitam, então a tela não oferece um terceiro caminho que o banco
       recusaria.
       A QUADRA só aparece depois do local escolhido: sem lugar não há quadra
       pra reservar, e perguntar antes é perguntar no vazio. A BOLA aparece
       sempre — leva-se bola pra qualquer lugar, inclusive pro "a combinar". */
    const _par = (nome, atual, fn, rotulo) => `
      <div style="font-size:12px;color:var(--ink2);margin:12px 0 6px">${rotulo} <span style="color:var(--ink3)">(opcional)</span></div>
      <div style="display:flex;gap:8px">
        ${[['eu','Eu'],['ele',_on.adv.nome.split(' ')[0]]].map(([v,n])=>
          `<button onclick="_net.${fn}('${v}')" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--linha2);font:600 12px system-ui;cursor:pointer;background:${atual===v?'#2C5A00':'var(--sup2)'};color:#fff">${n}</button>`).join('')}
      </div>`;
    const qpH = _par('quadra', _on.quadraPor, 'onQuadraPor', '🏟 Quem reserva a quadra');
    const bpH = _par('bola',   _on.bolaPor,   'onBolaPor',   '🎾 Quem leva a bola');
    const locH = ls.length ? `
      <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">📍 Onde</div>
      <select onchange="_net.onLocal(this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">
        <option value="" ${!_on.localId?'selected':''}>A combinar</option>
        ${ls.map(l=>`<option value="${l.id}" ${_on.localId===l.id?'selected':''}>${l.nome}</option>`).join('')}
      </select>
      ${_endLinha(lSel)}
      ${lSel?`<input type="number" min="1" max="${lSel.quadras}" value="${_on.quadra||''}" oninput="_net.onQuadra(this.value)" placeholder="Quadra (opcional, 1–${lSel.quadras})"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:8px">`:''}
      ${lSel?qpH:''}
      <div style="height:14px"></div>` : '';
    body = `<div style="font:700 17px system-ui;margin-bottom:2px">${ehContra?`Propor outro combinado`:`Desafiar ${_on.adv.nome}`}</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:14px">${ehContra
        ? `${_on.adv.nome.split(' ')[0]} recebe a proposta e aceita (ou propõe de volta). Dá pra ir e voltar até três vezes — depois é aceitar ou deixar pra lá.${_on.rodadas?` <b>${_on.rodadas} de 3 já foram.</b>`:''}`
        : `Ele recebe o desafio e aceita (ou recusa) no app dele. Depois de aceito é que vocês lançam o placar.`}</div>
      ${_farmAviso(_on.adv.nome.split(' ')[0])}
      ${qdoH}${locH}${bpH}
      <div style="height:16px"></div>
      <div style="display:flex;gap:8px">${_btn('Cancelar','_net.fechar()')}${ehContra
        ? _btn('Propor','_net.enviarContra()','ok')
        : _btn('Desafiar','_net.confirmarDesafio()','ok')}</div>
      ${ehContra?'':`<div style="font-size:11px;color:var(--ink3);margin-top:12px;text-align:center">Cantar a pedra (apostar como vai ganhar) entra aqui em breve.</div>`}`;
  }
  else if(_on.step==='mao'){
    const _p2m=(n)=>String(n).padStart(2,'0');
    const qvm = _on.quando ? (()=>{ const x=new Date(_on.quando);
      return `${x.getFullYear()}-${_p2m(x.getMonth()+1)}-${_p2m(x.getDate())}T${_p2m(x.getHours())}:${_p2m(x.getMinutes())}`; })() : '';
    const eleg=_maoElegiveis();
    const ls=_locaisMarcaveis(); const lSel=_locDe(_on.localId);   // clube do ADM + as minhas quadras
    let previa='';
    if(_on.sets && _on.advId){
      const eu=S.jogadores[EU]; const adv=S.jogadores[_on.advId];
      let g=0,p=0; _on.sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
      const venceu=g>p;
      /* (20/08) A MESMA CONTA DO OUTRO LADO. Em duplas a prévia é da MÉDIA do
         time, no trilho da ladder, com a calibragem fora — espelho do ramo de
         duplas do `_matches_motor` (mig 46). Antes esta prévia passava
         `dupla:false` cravado, e desde que o "lançar na mão" aceita duplas
         isso seria a tela prometendo um número que o banco não vai creditar. */
      let meuN, advNivel, calib, calN;
      if(_on.dupla){
        const parMeu = S.jogadores[_chaveLocal(_on.parCri)];
        const parAdv = S.jogadores[_chaveLocal(_on.parAdv)];
        meuN     = parMeu ? _motorTime(_ladderDe(eu),  _ladderDe(parMeu)) : _ladderDe(eu);
        advNivel = parAdv ? _motorTime(_ladderDe(adv), _ladderDe(parAdv)) : _ladderDe(adv);
        calib=false; calN=0;
      } else {
        meuN = nivelDe(eu);
        advNivel=(S.esporte==='beach')?(adv.nivelB??1200):(adv.nivel??1200);
        calib=eu.calibrando; calN=eu.cal;
      }
      // (53) a cota de zebra do par viaja no 9º argumento — a prévia faz a
      // MESMA conta do motor, com o mesmo interruptor
      const c=calcular(meuN, advNivel, venceu, 'amistoso', _on.fmt, !!_on.dupla, calib, calN, !_on.zebraJa);
      // (16/08) anti-farm: da 5ª do mês os Pontos saem a 25% — a prévia mostra
      // o que o banco vai creditar, não o cheio. O Nível não é tocado.
      const ptsM = _on.nPar>=4 ? _farmPts(c.dPts) : c.dPts;
      previa=`<div style="display:flex;gap:14px;justify-content:center;margin:12px 0">
        <div style="text-align:center"><div style="font:700 20px system-ui;color:${c.dNivel>=0?'var(--up)':'var(--dn)'}">${c.dNivel>0?'+':''}${c.dNivel}</div><div style="font-size:10px;color:var(--ink2)">${_on.dupla?'NÍVEL DE DUPLAS':'NÍVEL'}</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui;color:${ptsM>=0?'var(--up)':'var(--dn)'}">${ptsM>0?'+':''}${ptsM}</div><div style="font-size:10px;color:var(--ink2)">PONTOS</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui">${venceu?'Vitória':'Derrota'}</div><div style="font-size:10px;color:var(--ink2)">RESULTADO</div></div>
      </div>${(!c.zebra && venceu && _on.zebraJa && faixa(advNivel)>faixa(meuN))?'<p style="text-align:center;color:var(--ink3);font-size:12px">Zebra já usada contra ele nesta temporada — pontos na base.</p>':''}`;
    }
    body=`<div style="font:700 17px system-ui;margin-bottom:2px">Lançar na mão</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:12px">Partida jogada fora do app. ${_on.advId?_nomeDe(_on.advId).split(' ')[0]+' recebe o placar e':'O adversário recebe o placar e'} confirma no app dele — com o mesmo prazo de 72h. Não vai contar em circuito aberto, só nas fechadas.</div>
      <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">Contra quem</div>
      <select onchange="_net.maoAdv(this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">
        <option value="" ${!_on.advId?'selected':''}>Escolher…</option>
        ${eleg.map(u=>`<option value="${u}" ${_on.advId===u?'selected':''}>${_nomeDe(u)}${netEhAmigo(u)?' · amigo':''}</option>`).join('')}
      </select>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Amigo em qualquer classe; fora isso, a mesma janela de ±1 classe do radar.</div>
      ${_on.advId ? _farmAviso(_nomeDe(_on.advId).split(' ')[0]) : ''}
      <div style="display:flex;gap:8px;margin-top:10px">
        ${[['md3','Melhor de 3'],['set','Set único']].map(([v,n])=>`<button onclick="_net.maoFmt('${v}')" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--linha2);font:600 12px system-ui;cursor:pointer;background:${_on.fmt===v?'#2C5A00':'var(--sup2)'};color:#fff">${n}</button>`).join('')}
      </div>
      <div style="height:12px"></div>
      ${_on.advId ? _duplaBloco(_nomeDe(_on.advId).split(' ')[0],
          `O jogo já aconteceu, então não há o que combinar: ${_nomeDe(_on.advId).split(' ')[0]} confirma o placar pelos dois. O Nível de duplas dos quatro mexe junto.`) : ''}
      <div style="font-size:12px;color:var(--ink2);margin:12px 0 6px">Placar — seus games primeiro. Ex: <b>6-3 6-4</b></div>
      <input id="net-sc" value="${_on.placarTxt||''}" oninput="_net.digitou(this.value)" placeholder="6-3 6-4"
        style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 17px system-ui;text-align:center;letter-spacing:.05em" autocomplete="off"/>
      ${previa}
      <div style="font-size:12px;color:var(--ink2);margin:10px 0 6px">🗓 Quando foi <span style="color:var(--ink3)">(opcional)</span></div>
      <input type="datetime-local" value="${qvm}" max="${new Date().toISOString().slice(0,16)}" onchange="_net.onQuando(this.value)"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;color-scheme:dark"/>
      ${ls.length?`<div style="font-size:12px;color:var(--ink2);margin:10px 0 6px">📍 Onde <span style="color:var(--ink3)">(opcional)</span></div>
      <select onchange="_net.onLocal(this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">
        <option value="" ${!_on.localId?'selected':''}>Não lembro / outro lugar</option>
        ${ls.map(l=>`<option value="${l.id}" ${_on.localId===l.id?'selected':''}>${l.nome}</option>`).join('')}
      </select>
      ${_endLinha(lSel)}
      ${lSel?`<input type="number" min="1" max="${lSel.quadras}" value="${_on.quadra||''}" oninput="_net.onQuadra(this.value)" placeholder="Quadra (opcional, 1–${lSel.quadras})"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:8px">`:''}`:''}
      <div style="display:flex;gap:8px;margin-top:14px">${_btn('Cancelar','_net.fechar()')}${(_on.sets&&_on.advId)?_btn('Lançar placar','_net.maoEnviar()','ok'):''}</div>`;
  }
  else if(_on.step==='placar'){
    const eu=S.jogadores[EU]; const sets=_on.sets; let previa='';
    if(sets){
      let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
      const venceu=g>p;
      /* (46) EM DUPLAS A CONTA É DA MÉDIA DO TIME, no trilho da ladder — e a
         calibragem sai (o motor chama duplas com false,0). Espelha o ramo de
         duplas do `_matches_motor`; qualquer divergência aqui é a tela
         prometendo um número que o banco não vai creditar. */
      let meuN, advNivel, calib, calN;
      if(_on.dupla){
        /* `parMeu`/`parDele` vêm resolvidos por assento no `netLancarPlacar`.
           No fluxo de DESAFIO quem cria é sempre o criador, então `parCri` já
           é o meu parceiro — o `??` cobre os dois caminhos sem duplicar regra. */
        const parMeu = S.jogadores[_chaveLocal(_on.parMeu  ?? _on.parCri)];
        const parAdv = S.jogadores[_chaveLocal(_on.parDele ?? _on.parAdv)];
        meuN    = parMeu ? _motorTime(_ladderDe(eu), _ladderDe(parMeu)) : _ladderDe(eu);
        advNivel= parAdv ? _motorTime(_ladderDe(_on.adv), _ladderDe(parAdv)) : _ladderDe(_on.adv);
        calib=false; calN=0;
      } else {
        meuN = nivelDe(eu);
        advNivel=(S.esporte==='beach')?(_on.adv.nivelb??1200):(_on.adv.nivel??1200);
        calib=eu.calibrando; calN=eu.cal;
      }
      // (53) o interruptor da zebra entra na prévia igual entra no motor
      const c=calcular(meuN, advNivel, venceu, _on.ctx||'amistoso', _on.fmt, !!_on.dupla, calib, calN, !_on.zebraJa);
      // (16/08) anti-farm: a MESMA conta do `pontos_creditar` — Pontos a 25%
      // da 5ª do mês, Nível intacto. Prévia que mostra o cheio aqui mente.
      const ptsP = _on.nPar>=4 ? _farmPts(c.dPts) : c.dPts;
      previa=`<div style="display:flex;gap:14px;justify-content:center;margin:14px 0">
        <div style="text-align:center"><div style="font:700 20px system-ui;color:${c.dNivel>=0?'var(--up)':'var(--dn)'}">${c.dNivel>0?'+':''}${c.dNivel}</div><div style="font-size:10px;color:var(--ink2)">${_on.dupla?'NÍVEL DE DUPLAS':'NÍVEL'}</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui;color:${ptsP>=0?'var(--up)':'var(--dn)'}">${ptsP>0?'+':''}${ptsP}</div><div style="font-size:10px;color:var(--ink2)">PONTOS</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui">${venceu?'Vitória':'Derrota'}</div><div style="font-size:10px;color:var(--ink2)">RESULTADO</div></div>
      </div>${c.zebra?'<p style="text-align:center;color:var(--up);font-size:12px">Zebra — multiplicador nos pontos.</p>':''}${(!c.zebra && venceu && _on.zebraJa && faixa(advNivel)>faixa(meuN))?'<p style="text-align:center;color:var(--ink3);font-size:12px">Zebra já usada contra ele nesta temporada — pontos na base.</p>':''}`;
    }
    body=`<div style="font:700 17px system-ui;margin-bottom:2px">Placar vs ${_on.adv.nome}</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:10px">Seus games primeiro. Toque nos sets ou digite.</div>
      ${_farmAviso(_on.adv.nome.split(' ')[0])}
      <input id="net-sc" value="${_on.placarTxt||''}" oninput="_net.digitou(this.value)" placeholder="6-3 6-4"
        style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 18px system-ui;text-align:center;letter-spacing:.05em" autocomplete="off"/>
      ${_linhaPlacares('Set que VOCÊ ganhou', false)}
      ${_linhaPlacares('Set que você PERDEU', true)}
      ${(_on.placarTxt||'').trim() ? `<button onclick="_net.tiraSet()" style="width:100%;margin-top:8px;padding:9px;border-radius:9px;border:1px solid var(--linha2);background:none;color:var(--ink2);font:600 12px system-ui;cursor:pointer">← apagar o último set</button>` : ''}
      ${previa}
      <div style="display:flex;gap:8px;margin-top:8px">${_btn('Voltar','_net.fechar()')}${sets?_btn('Enviar placar','_net.enviar()','ok'):''}</div>`;
  }
  else if(_on.step==='placar-org'){
    const sets=_on.sets; const nA=_on.a.nome.split(' ')[0], nB=_on.b.nome.split(' ')[0];
    let previa='';
    if(sets){
      let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
      previa=`<div style="text-align:center;font:700 16px system-ui;margin:14px 0;color:${g===p?'var(--dn)':'var(--up)'}">${g===p?'Placar empatado — confira':(g>p?nA:nB)+' venceu'}</div>`;
    }
    body=`<div style="font:700 17px system-ui;margin-bottom:2px">Placar do organizador</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:10px"><b>${nA}</b> × ${nB} — games de <b>${nA}</b> primeiro. Ex: <b>6-3 6-4</b></div>
      <input id="net-sc" value="${_on.placarTxt||''}" oninput="_net.digitou(this.value)" placeholder="6-3 6-4"
        style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 18px system-ui;text-align:center;letter-spacing:.05em" autocomplete="off"/>
      ${previa}
      <div style="display:flex;gap:8px;margin-top:8px">${_btn('Voltar','_net.fechar()')}${sets?_btn('Confirmar placar','_net.orgEnviar()','ok'):''}</div>
      <div style="font-size:11px;color:var(--ink3);margin-top:10px;text-align:center">Vale na hora, sem confirmação dos jogadores. Fica registrado que o organizador lançou.</div>`;
  }
  _sheet('net-online', body);
  const sc=document.getElementById('net-sc'); if(sc){ sc.focus(); sc.setSelectionRange(sc.value.length,sc.value.length); }
}
let _on=null;

/* ---- Buscar amigos (por nome/email/ID) -------------------------------- */
let _busca = {termo:'', resultados:[]};
function netAbrirBusca(){
  _busca={termo:'',resultados:[]};
  netRenderBusca();
  /* os dois lados da relação, buscados em paralelo e redesenhados quando
     chegam: sem isto o primeiro render mostraria "Pedir amizade" pra quem já
     foi pedido, que é o estado errado no exato momento em que a tela abre. */
  Promise.all([
    netCarregarPedidosEnviados(true),
    (window.netCarregarPedidosAmizade ? netCarregarPedidosAmizade(true) : Promise.resolve([]))
  ]).then(()=>{ if(document.getElementById('net-busca')) netRenderBusca(); })
   .catch(e=>console.error('[net] pedidos na busca', e));
}
function netFecharBusca(){ const el=document.getElementById('net-busca'); if(el) el.remove(); }
async function _onBuscar(v){ _busca.termo=v; _busca.resultados = await netBuscar(v); netRenderBusca(); }
window.netRenderBusca = netRenderBusca;
function netRenderBusca(){
  const linhas=_busca.resultados.map(p=>{
    const amigo=netEhAmigo(p.id);
    /* três estados, não dois: sem relação · pedido enviado · pedido recebido.
       Antes só existiam "amigo" e "não amigo", então o pedido enviado ficava
       invisível e o botão continuava oferecendo o que já tinha sido feito. */
    const jaPedi=!amigo && netJaPedi(p.id);
    const mePediu=!amigo && (window.netPedidosAmizade?netPedidosAmizade():[]).some(x=>x.de===p.id);
    const div=window.divisaoDe?divisaoDe(p.nivel):'';
    const nomeEsc=(p.nome||'').replace(/'/g,'’');
    return `<div style="display:flex;align-items:center;gap:11px;padding:11px;border:1px solid var(--linha);border-radius:12px;margin-top:8px">
      ${_disco(p, 36)}
      <div style="flex:1;min-width:0"><b>${p.nome}</b> <span style="color:var(--ink3);font-size:11px">${netId(p.id)}</span>
        <div style="font-size:11px;color:var(--ink2)">Classe ${div} · Nível ${p.nivel}${amigo?' · <span style="color:var(--up)">✔ amigo</span>':''}</div></div>
      <div style="display:flex;flex-direction:column;gap:5px">
        ${amigo?''
          : mePediu?`<button onclick="_net.aceitarAmizade('${p.id}')" style="padding:7px 10px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Aceitar</button>`
          : jaPedi?`<div style="padding:7px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--sup);color:var(--ink3);font:600 12px system-ui;text-align:center">⏳ pedido enviado</div>`
          : `<button onclick="_net.addAmigo('${p.id}','${nomeEsc}')" style="padding:7px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:600 12px system-ui;cursor:pointer">Pedir amizade</button>`}
        <button onclick="_net.desafiarUid('${p.id}','${nomeEsc}',${p.nivel},${p.nivelb||1200})" style="padding:7px 10px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Desafiar</button>
      </div></div>`;
  }).join('') || (_busca.termo?`<p style="color:var(--ink2);font-size:13px;margin-top:12px">Ninguém encontrado por “${_busca.termo}”.</p>`:'');
  _sheet('net-busca', `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div style="font:700 17px system-ui">Buscar amigos</div>
      <button onclick="_net.fecharBusca()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin-bottom:10px">Por nome, email ou ID (o seu é ${netId(MEU_UID)}). Amigo você desafia em qualquer classe.</div>
    <input id="net-bq" value="${_busca.termo}" oninput="_net.buscar(this.value)" placeholder="nome, email ou #ID"
      style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui" autocomplete="off"/>
    <button onclick="_net.convidarAmigo()" style="width:100%;padding:12px;border-radius:11px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:10px">🔗 Convidar amigo por link</button>
    <div style="font-size:11px;color:var(--ink3);text-align:center;margin-top:5px">Manda no WhatsApp — quem abrir te manda um pedido de amizade.</div>
    ${linhas}`);
  const bq=document.getElementById('net-bq'); if(bq){ bq.focus(); bq.setSelectionRange(bq.value.length,bq.value.length); }
}

// convite de amizade por link (?a=<meu uid>) — quem abre me adiciona
async function netConvidarAmigo(){
  const url = location.origin + location.pathname + '?a=' + MEU_UID;
  try{ await navigator.clipboard.writeText(url); if(window.toast) toast('Link copiado! Quem abrir te manda um pedido.'); }
  catch(e){ prompt('Copie o link e mande pro amigo:', url); }
}

// desafiar alguém achado na busca (pode não estar no elenco local / outra divisão)
function netDesafiarUid(id, nome, nivel, nivelb){
  netFecharBusca();
  _on = { step:'desafio', advId:id, adv:{id, nome, nivel, nivelb} };
  _farmContar(id);
  netRenderOnline();
}
window.netAbrirBusca = netAbrirBusca;

/* =========================================================================
   GRUPOS — criar, pedir pra entrar (pendente/recusado), gestão (dono/admin)
   e link de convite revogável. Comunidade é porta com porteiro; o link é o
   convite do gestor e entra direto.
   ========================================================================= */
let _gnew = null;

async function netMeusGrupos(){
  const m = await sb.from('grupo_membros').select('grupo_id,papel').eq('player_id',MEU_UID);
  const papel={}; (m.data||[]).forEach(x=>papel[x.grupo_id]=x.papel);
  const meusIds=Object.keys(papel);
  let meus=[]; if(meusIds.length){ meus=(await sb.from('grupos').select('*').in('id',meusIds).order('created_at',{ascending:false})).data||[]; }
  const ab=(await sb.from('grupos').select('*').eq('aberto',true).order('created_at',{ascending:false})).data||[];
  const abertos=ab.filter(g=>!papel[g.id]);
  // meus pedidos (pra mostrar "enviado"/"não rolou" no card)
  const pd=(await sb.from('grupo_pedidos').select('grupo_id,estado').eq('player_id',MEU_UID)).data||[];
  const pedido={}; pd.forEach(p=>pedido[p.grupo_id]=p.estado);
  const todos=[...meus,...abertos]; const cont={};
  if(todos.length){ const c=await sb.from('grupo_membros').select('grupo_id').in('grupo_id',todos.map(g=>g.id));
    (c.data||[]).forEach(x=>cont[x.grupo_id]=(cont[x.grupo_id]||0)+1); }
  /* 26/08: espelho pra render síncrono, mesmo padrão do `__meusQuadros`. O
     `select('*')` acima JÁ traz `cinturao`, `cinturao_dono_id` e
     `cinturao_desde` — a Sala de Conquistas mostrava "sem dono" fixo porque o
     dado morria nesta linha, não porque faltava no banco. */
  window.__meusGrupos = meus;
  return {meus,abertos,papel,pedido,cont};
}

// linha "quem sou eu" — visível nas listas pra nunca mais testar às cegas
function _quemSou(){
  return `<div style="font-size:11px;color:var(--ink3);margin-top:3px">Neste aparelho: <b style="color:var(--ink2)">${_nomeDe(MEU_UID)}</b> ${netId(MEU_UID)} · <span onclick="_net.trocarConta()" style="text-decoration:underline;cursor:pointer">trocar de conta</span></div>`;
}
async function netTrocarConta(){
  if(!confirm('Sair desta conta neste aparelho? O app volta pra tela inicial.')) return;
  await netLogout();
  try{ localStorage.removeItem('appTenis'); }catch(e){}
  location.reload();
}

async function netAbrirGrupos(){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const {meus,abertos,pedido,cont}=await netMeusGrupos();
  const card=(g,fora)=>{
    let acao='<span style="color:var(--ink2)">›</span>';
    if(fora){
      const st=pedido[g.id];
      acao = st==='pendente' ? '<span style="color:var(--gold);font-size:11px">pedido enviado</span>'
        : st==='recusado' ? `<button onclick="event.stopPropagation();_net.pedirEntrar('${g.id}')" style="padding:7px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:600 11px system-ui;cursor:pointer">Não rolou · pedir de novo</button>`
        : `<button onclick="event.stopPropagation();_net.pedirEntrar('${g.id}')" style="padding:7px 12px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Pedir pra entrar</button>`;
    }
    return `<div onclick="_net.verGrupo('${g.id}')" style="display:flex;align-items:center;gap:11px;padding:13px;border:1px solid var(--linha);border-radius:12px;margin-top:8px;cursor:pointer">
      <div style="width:34px;height:34px;border-radius:9px;background:var(--sup2);display:flex;align-items:center;justify-content:center;font-size:16px;flex:0 0 34px">▣</div>
      <div style="flex:1;min-width:0"><b>${g.nome}</b>
        <div style="font-size:11px;color:var(--ink2)">${g.esporte==='beach'?'Beach':'Tênis'} · ${cont[g.id]||0} membros · ${g.aberto?'aberto':'fechado'}</div></div>
      ${acao}</div>`;
  };
  const meusH = meus.length? meus.map(g=>card(g,false)).join('') : `<p style="color:var(--ink2);font-size:13px;margin-top:8px">Você ainda não está em nenhuma comunidade.</p>`;
  const abH = abertos.length? `<div style="font:700 12px system-ui;color:var(--ink2);margin-top:16px;text-transform:uppercase;letter-spacing:.08em">Comunidades abertas</div>`+abertos.map(g=>card(g,true)).join('') : '';
  _sheet('net-comunidades', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Comunidades</div>
      <button onclick="_net.fecharGrupos()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    ${_quemSou()}
    <button onclick="_net.criarGrupo()" style="width:100%;padding:13px;border-radius:12px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:700 14px system-ui;cursor:pointer;margin-top:10px">+ Criar comunidade</button>
    <input oninput="_net.buscarGrupos(this.value)" placeholder="Buscar comunidade pelo nome (achou, pede pra entrar)"
      style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:10px" autocomplete="off"/>
    <div id="gg-res"></div>
    <div style="font:700 12px system-ui;color:var(--ink2);margin-top:16px;text-transform:uppercase;letter-spacing:.08em">Suas comunidades</div>
    ${meusH}${abH}`);
}
function netFecharGrupos(){ const el=document.getElementById('net-comunidades'); if(el) el.remove(); }

// busca de comunidade pelo nome — acha inclusive os FECHADOS (o pedido continua
// passando pelo porteiro; fechado = não listado, não inencontrável)
async function netBuscarGrupos(q){
  const box=document.getElementById('gg-res'); if(!box) return;
  q=(q||'').trim();
  if(q.length<2){ box.innerHTML=''; return; }
  const { data } = await sb.from('grupos').select('*').ilike('nome','%'+q+'%').limit(12);
  box.innerHTML = (data||[]).map(g=>`<div onclick="_net.verGrupo('${g.id}')" style="display:flex;align-items:center;gap:11px;padding:12px;border:1px solid var(--linha);border-radius:12px;margin-top:8px;cursor:pointer">
      <div style="width:30px;height:30px;border-radius:9px;background:var(--sup2);display:flex;align-items:center;justify-content:center;font-size:14px;flex:0 0 30px">▣</div>
      <div style="flex:1;min-width:0"><b>${g.nome}</b><div style="font-size:11px;color:var(--ink2)">${g.esporte==='beach'?'Beach':'Tênis'} · ${g.aberto?'aberto':'fechado'}</div></div>
      <span style="color:var(--ink2)">›</span></div>`).join('')
    || `<p style="color:var(--ink2);font-size:12px;margin-top:8px">Nenhuma comunidade com “${q}”.</p>`;
}

/* ---- Pontos de Temporada (banco) ---------------------------------------
   Antes daqui os Pontos viviam em `S.pontos` no localStorage: eram do
   APARELHO, não da conta — divergiam entre celular e Mac e sumiam num aparelho
   novo. O ranking é a SOMA do livro-caixa, nunca um saldo guardado. */
let _temp;
async function netTemporada(){
  if(_temp !== undefined) return _temp;
  try{ const r = await sb.rpc('temporada_atual'); _temp = (r && r.data != null) ? r.data : null; }
  catch(e){ _temp = null; }
  return _temp;
}

/* Idempotente pela PK do livro-caixa: dois aparelhos creditando a mesma
   partida ao mesmo tempo não credita em dobro. */
async function netCreditarPontos(mid){
  if(!mid) return;
  try{ await sb.rpc('pontos_creditar', { mid }); }
  catch(e){ /* pontos nunca derrubam a confirmação do placar */ }
}

// escopo: 'geral' · 'grupo:<uuid>' · 'torneio:<uuid>'
async function netRanking(escopo, esporte){
  const t = await netTemporada();
  if(t == null) return {};
  try{
    const { data } = await sb.from('pontos_lancamentos')
      .select('player_id,pontos')
      .eq('temporada', t).eq('esporte', esporte).eq('escopo', escopo);
    const soma = {};
    (data||[]).forEach(r=>{ soma[r.player_id] = (soma[r.player_id]||0) + r.pontos });
    return soma;
  }catch(e){ return {} }
}

/* =========================================================================
   AS COMUNIDADES REAIS NO QUADRO (12/08)

   Até aqui o quadro mostrava um "Circuito do Clube Bahiano" que era estado
   local fixo: recebia exatamente o mesmo dPts da comunidade e tinha exatamente
   os mesmos membros — o mesmo ranking, duas vezes, com o vocabulário do bloco
   de Ligas revogado em 09/08. Pior, o texto dele dizia "qualquer partida sua
   alimenta ele, mesmo contra quem não é membro", e o banco faz o contrário.

   O container de verdade é a COMUNIDADE, e o ranking dela já existe desde a
   migração 17: `pontos_creditar` carimba cada lançamento com um escopo e só
   escreve `grupo:<id>` quando OS DOIS jogadores são membros — que é o
   "alimentado pelas partidas entre membros" decidido em 09/08.

   O render do quadro é síncrono e não pode esperar query, então o resultado
   mora num espelho em `window`, mesmo padrão do `__meusLocais`.
   ========================================================================= */
let _quadros = null;

async function netMeusQuadros(force){
  if(_quadros && !force) return _quadros;
  if(!MEU_UID){ _quadros = null; return []; }
  const esp = (typeof S !== 'undefined' && S.esporte) || 'tenis';
  try{
    const { meus, cont } = await netMeusGrupos();
    /* só as comunidades DO ESPORTE corrente: o livro-caixa é carimbado por
       esporte, e misturar traria a posição de um trilho dentro do outro. */
    const doEsporte = (meus||[]).filter(g => (g.esporte||'tenis') === esp);
    _quadros = await Promise.all(doEsporte.map(async g=>{
      const soma  = await netRanking('grupo:'+g.id, esp);
      const ordem = Object.entries(soma).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
      const i = ordem.indexOf(MEU_UID);
      return { id:g.id, nome:g.nome, membros:(cont && cont[g.id]) || 0,
               /* sem lançamento nenhum eu não estou na soma. Posição fica NULA
                  em vez de virar "1º" — agregado sem o que agregar precisa de
                  caso explícito, senão o vazio mente com cara de dado. */
               pos: i >= 0 ? i+1 : null,
               pts: soma[MEU_UID] || 0 };
    }));
  }catch(e){ _quadros = []; }
  window.__meusQuadros = _quadros;
  if(window.render){ try{ render(); }catch(e){} }
  return _quadros;
}

/* =========================================================================
   DESTAQUE POR MOVIMENTO, NÃO POR POSIÇÃO (12/08)

   Do protótipo `quadro-circuito`, congelado em 04/08 e revisto hoje. O
   argumento é o mais forte que sobrou dele: *se só o primeiro aparece, os 90%
   de baixo ficam invisíveis — e são eles que abandonam primeiro*. Por isso a
   evidência é ESCASSA (quatro) e ROTATIVA: premia o que mudou na semana, não
   quem está no topo. Ataca retenção, que é o gargalo de um produto cuja
   métrica é jogos a mais.

   "Quem mais subiu" só é calculável porque o livro-caixa guarda o LANÇAMENTO
   com `criado_em`, e não o saldo: dá pra somar até uma data de corte e
   reconstruir o quadro de sete dias atrás. Com um acumulador isso exigiria uma
   tabela de fotografias que ninguém escreveu.

   Calculado no CLIENTE, em duas consultas. SQL novo seria mais elegante e só
   rodaria em produção — e a regra do projeto é que entre o elegante que não dá
   pra testar e o testável que dá pra rodar quinze vezes antes de entregar, o
   testável ganha. Aqui não há escrita, migração nem superfície de RLS nova.

   TETO: as duas consultas trazem a temporada inteira (limitadas a 500
   partidas). Serve com folga pro lançamento clube por clube; quando o volume
   crescer, isto vira view no banco.
   ========================================================================= */
const DESTAQUE_DIAS = 7;
let _destaques = null;

async function netDestaques(force){
  if(_destaques && !force) return _destaques;
  if(!MEU_UID){ _destaques = null; return []; }
  const esp = (typeof S !== 'undefined' && S.esporte) || 'tenis';
  try{
    const t = await netTemporada();
    /* Toda comparação de data aqui é em MILISSEGUNDOS, nunca em texto: o
       Postgres devolve o carimbo como `...+00:00` e o `toISOString()` produz
       `...Z`. Comparadas como string, as duas divergem no meio do carimbo e o
       filtro erra em silêncio — que é o pior tipo de erro. */
    const corteMs = Date.now() - DESTAQUE_DIAS*24*3600e3;
    const ms = (v)=> Date.parse(v);

    /* A janela NÃO entra na consulta de partidas de propósito: a sequência de
       vitórias e a estreia precisam de história anterior aos sete dias. Quem
       recorta por data é cada destaque, abaixo. */

    const [ps, ls] = await Promise.all([
      sb.from('matches')
        .select('id,criador_id,adversario_id,venceu_criador,delta_criador,delta_adversario,confirmed_at')
        .eq('status','confirmada').eq('esporte',esp)
        .order('confirmed_at',{ascending:false}).limit(500),
      t == null ? Promise.resolve({data:[]}) : sb.from('pontos_lancamentos')
        .select('player_id,pontos,criado_em')
        .eq('temporada',t).eq('esporte',esp).eq('escopo','geral'),
    ]);
    const partidas = (ps.data||[]).filter(m=>m.confirmed_at);
    const lanc     = ls.data || [];

    /* ---- 1. quem mais subiu: quadro de hoje contra o de sete dias atrás ---
       Quem não tinha lançamento antes do corte não "subiu" — ele estreou, e é
       o quarto destaque. Somar posição pra quem não tinha posição inventaria
       um salto que não aconteceu. */
    const somar = (ateMs)=>{
      const s={}; lanc.forEach(l=>{ if(ateMs==null || ms(l.criado_em) <= ateMs) s[l.player_id]=(s[l.player_id]||0)+l.pontos });
      return Object.entries(s).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
    };
    const agora = somar(null), antes = somar(corteMs);
    let subiu = null;
    agora.forEach((pid,i)=>{
      const j = antes.indexOf(pid); if(j < 0) return;
      const d = j - i;
      if(d > 0 && (!subiu || d > subiu.d)) subiu = { pid, d };
    });

    /* ---- 2. maior zebra da janela ----------------------------------------
       `zebra` viaja no delta do jogador, gravado na confirmação. O critério de
       "maior" é o dPts do vencedor: é o número que o próprio motor já usou pra
       dizer o tamanho do feito, em vez de eu inventar uma segunda régua. */
    let zebra = null;
    partidas.filter(m=> ms(m.confirmed_at) >= corteMs).forEach(m=>{
      const venc = m.venceu_criador ? m.delta_criador : m.delta_adversario;
      if(!venc || !venc.zebra) return;
      const pid = m.venceu_criador ? m.criador_id : m.adversario_id;
      if(!zebra || (venc.dPts||0) > zebra.pts) zebra = { pid, pts: venc.dPts||0 };
    });

    /* ---- 3. sequência de vitórias mais longa, contando do jogo mais recente
       pra trás. Quebra na primeira derrota — é "sequência atual", não recorde. */
    const seq = {}, parou = {};
    partidas.forEach(m=>{                       // já vêm do mais novo pro mais velho
      [[m.criador_id, m.venceu_criador], [m.adversario_id, !m.venceu_criador]].forEach(([pid,ganhou])=>{
        if(parou[pid]) return;
        if(ganhou) seq[pid] = (seq[pid]||0) + 1; else parou[pid] = true;
      });
    });
    let melhor = null;
    Object.entries(seq).forEach(([pid,n])=>{ if(n >= 2 && (!melhor || n > melhor.n)) melhor = { pid, n } });

    /* ---- 4. quem estreou: primeira partida confirmada dentro da janela ---- */
    const primeira = {};
    partidas.forEach(m=>{                       // do mais novo pro mais velho: a última escrita é a mais antiga
      primeira[m.criador_id]    = m.confirmed_at;
      primeira[m.adversario_id] = m.confirmed_at;
    });
    const novatos = Object.keys(primeira).filter(pid => ms(primeira[pid]) >= corteMs);

    /* Só entra o destaque que tem base real. Sem candidato, a linha não existe
       — quatro caixas preenchidas na marra seriam o mesmo vazio disfarçado de
       estado que o circuito falso era. */
    const out = [];
    if(subiu)  out.push({ ic:'🚀', k:'quem mais subiu',      v:_nomeDe(subiu.pid),  d:`+${subiu.d} ${subiu.d===1?'posição':'posições'} em ${DESTAQUE_DIAS} dias` });
    if(zebra)  out.push({ ic:'🦓', k:'maior zebra',           v:_nomeDe(zebra.pid),  d:`venceu quem estava acima · +${zebra.pts} pts` });
    if(melhor) out.push({ ic:'🔥', k:'sequência mais longa',  v:_nomeDe(melhor.pid), d:`${melhor.n} vitórias seguidas` });
    if(novatos.length) out.push({ ic:'🌱', k:'quem estreou',
      v: novatos.length===1 ? _nomeDe(novatos[0]) : `${novatos.length} jogadores`,
      d: novatos.length===1 ? 'primeira partida no app' : `entraram nos últimos ${DESTAQUE_DIAS} dias` });

    _destaques = out;
  }catch(e){ _destaques = []; }
  window.__destaques = _destaques;
  if(window.render){ try{ render(); }catch(e){} }
  return _destaques;
}

/* Onde ESTA partida caiu de verdade. Lido de volta do livro-caixa em vez de
   recalculado aqui: quem decide os escopos é o `pontos_creditar`, e duplicar
   essa regra no cliente criaria uma segunda verdade, que diverge da primeira
   vez que a do banco mudar. Falhou? devolve vazio, e a tela mostra só o que
   tem certeza — nunca completa com container inventado. */
async function netQuadrosDaPartida(mid){
  if(!mid || !MEU_UID) return [];
  try{
    const { data } = await sb.from('pontos_lancamentos')
      .select('escopo,pontos').eq('match_id', mid).eq('player_id', MEU_UID);
    const linhas = data || [];
    if(!linhas.length) return [];

    const gid = {}; ((await netMeusGrupos()).meus || []).forEach(g=>gid[g.id]=g.nome);
    const tids = linhas.filter(l=>l.escopo.startsWith('torneio:')).map(l=>l.escopo.slice(8));
    const tid = {};
    if(tids.length){
      const r = await sb.from('torneios').select('id,nome').in('id', tids);
      (r.data||[]).forEach(t=>tid[t.id]=t.nome);
    }
    return linhas.map(l=>({
      escopo: l.escopo,
      pontos: l.pontos,
      nome: l.escopo.startsWith('grupo:')   ? (gid[l.escopo.slice(6)] || 'Comunidade')
          : l.escopo.startsWith('torneio:') ? (tid[l.escopo.slice(8)] || 'Campeonato')
          : 'Quadro geral',
    }));
  }catch(e){ return [] }
}

/* ---- troféus de temporada: Reinado e Coroa (09/08) ---------------------
   Reinado — maior tempo de posse DEFENDIDA.
   Coroa   — quem terminou a temporada com o cinturão.

   INTERPRETAÇÃO DECLARADA: "posse defendida" foi lida como reinado com pelo
   menos UMA defesa. Sem esse corte, quem recebeu o cinturão por vencimento
   (os 30 dias) e ficou parado poderia levar o troféu de posse justamente por
   não jogar — e a regra do produto é que prêmio maximizável parando está
   apontado contra o produto. Se a leitura certa for outra, muda só o filtro
   `defesas > 0` aqui embaixo.

   Função pura: recebe os dados e devolve o veredito. É o que permite testar. */
function _apurarTrofeus(temp, reinados, partidas, membros, esporte, donoAtual){
  const ini = new Date(temp.inicio), fim = new Date(temp.fim);
  const ehMembro = {}; (membros||[]).forEach(id=>ehMembro[id]=1);
  const porJog = {};

  (reinados||[]).forEach(r=>{
    const rIni = new Date(r.inicio), rFim = r.fim ? new Date(r.fim) : fim;
    // recorta o reinado pela janela da temporada — reinado atravessa virada
    const a = new Date(Math.max(rIni, ini)), b = new Date(Math.min(rFim, fim));
    if(b <= a) return;
    const d = porJog[r.player_id] || (porJog[r.player_id] = {ms:0, defesas:0});
    d.ms += b - a;
    (partidas||[]).forEach(m=>{
      if(m.status !== 'confirmada' || m.esporte !== esporte) return;
      const t = m.confirmed_at ? new Date(m.confirmed_at) : null;
      if(!t || t < a || t >= b) return;
      const souCriador = m.criador_id === r.player_id;
      if(!souCriador && m.adversario_id !== r.player_id) return;
      const adv = souCriador ? m.adversario_id : m.criador_id;
      if(!ehMembro[adv]) return;                  // defesa é contra membro
      if(souCriador === !!m.venceu_criador) d.defesas++;
    });
  });

  const DIA = 864e5;
  const cand = Object.keys(porJog).filter(id=>porJog[id].defesas > 0)
                     .sort((x,y)=> porJog[y].ms - porJog[x].ms);
  const _d = cand.length ? Math.round(porJog[cand[0]].ms/DIA) : 0;
  const _f = cand.length ? porJog[cand[0]].defesas : 0;
  return {
    reinado: cand.length ? { player_id:cand[0],
      etiqueta:`${_d} ${_d===1?'dia':'dias'} · ${_f} ${_f===1?'defesa':'defesas'}` } : null,
    coroa: donoAtual ? { player_id:donoAtual, etiqueta:null } : null
  };
}

/* Cunha os troféus das comunidades em que EU sou membro e vira a temporada.
   Roda no boot. A exclusividade é do banco (unique temporada+comunidade+tipo), então
   vários aparelhos apurando ao mesmo tempo não geram troféu duplicado. */
async function netFecharTemporada(){
  try{
    const t = (await sb.from('temporadas').select('*').order('n',{ascending:false}).limit(1)).data;
    const temp = t && t[0];
    if(!temp || new Date(temp.fim) > new Date()) return;      // ainda correndo

    const meus = (await sb.from('grupo_membros').select('grupo_id').eq('player_id',MEU_UID)).data||[];
    for(const {grupo_id} of meus){
      const g = (await sb.from('grupos').select('id,esporte,cinturao,cinturao_dono_id')
                   .eq('id',grupo_id).maybeSingle()).data;
      if(!g || !g.cinturao) continue;
      const membros = ((await sb.from('grupo_membros').select('player_id').eq('grupo_id',grupo_id)).data||[])
                        .map(x=>x.player_id);
      const reinados = (await sb.from('cinturao_reinados').select('player_id,inicio,fim')
                          .eq('grupo_id',grupo_id)).data||[];
      const partidas = (await sb.from('matches')
                          .select('criador_id,adversario_id,venceu_criador,confirmed_at,status,esporte')
                          .eq('status','confirmada').eq('esporte',g.esporte)
                          .gte('confirmed_at',temp.inicio).lt('confirmed_at',temp.fim)).data||[];

      const {reinado, coroa} = _apurarTrofeus(temp, reinados, partidas, membros, g.esporte, g.cinturao_dono_id);
      const linhas = [];
      /* `origem:'auto'` explícito. É o default da coluna (migração 20), mas a
         policy de insert EXIGE o valor, e depender do default aqui é apostar
         na ordem em que o Postgres aplica default e WITH CHECK. Escrever custa
         uma palavra; descobrir que a apuração parou de cunhar custa a
         temporada inteira. */
      if(reinado) linhas.push({temporada:temp.n, grupo_id, tipo:'reinado', origem:'auto', ...reinado});
      if(coroa)   linhas.push({temporada:temp.n, grupo_id, tipo:'coroa',   origem:'auto', ...coroa});
      // conflito = outro aparelho já cunhou. É o resultado esperado, não erro.
      if(linhas.length) await sb.from('trofeus_temporada').insert(linhas);
    }
    await sb.rpc('temporada_virar');
    _temp = undefined;                                        // força reler a temporada
  }catch(e){ /* virada nunca derruba o boot */ }
}

/* ---- cinturão da comunidade (09/08) ----------------------------------------
   O banco guarda só quem tem e desde quando. Dias de reinado, defesas,
   congelamento e vencimento saem daqui — de `matches` + `cinturao_desde`.
   Estado derivado não se guarda; guardado, a etiqueta acabaria mentindo sobre
   uma partida que o banco já registrou. */
async function _cinturaoEstado(g, membros){
  if(!g || !g.cinturao || !g.cinturao_dono_id) return null;
  const dono  = g.cinturao_dono_id;
  const desde = g.cinturao_desde ? new Date(g.cinturao_desde) : null;
  const ids   = (membros||[]).map(m=>m.player_id);

  const ms = (await sb.from('matches')
    .select('criador_id,adversario_id,venceu_criador,confirmed_at')
    .eq('status','confirmada').eq('esporte', g.esporte)
    .or(`criador_id.eq.${dono},adversario_id.eq.${dono}`)).data || [];

  let defesas = 0, ultimo = null;
  ms.forEach(m=>{
    const t = m.confirmed_at ? new Date(m.confirmed_at) : null;
    if(t && (!ultimo || t > ultimo)) ultimo = t;
    if(!desde || !t || t < desde) return;
    const adv = m.criador_id === dono ? m.adversario_id : m.criador_id;
    if(ids.indexOf(adv) < 0) return;                       // defesa é contra membro
    if((m.criador_id === dono) === !!m.venceu_criador) defesas++;
  });

  const DIA = 864e5, agora = Date.now();
  const base = ultimo || desde;
  const parado = base ? Math.floor((agora - base.getTime())/DIA) : 0;
  const congelado = parado >= 14, vencido = parado >= 30;
  /* "Congela o reinado" é literal: aos 14 dias parados o contador para de
     andar. Sem isso, quem some do app continuaria acumulando reinado. */
  const fimContagem = congelado && base ? base.getTime() + 14*DIA : agora;
  const dias = desde ? Math.max(0, Math.floor((fimContagem - desde.getTime())/DIA)) : 0;

  return { dono, desde, dias, defesas, ultimo, parado, congelado, vencido };
}

/* Chamado depois de toda confirmação de placar. Não pergunta nada antes: a
   função do banco valida comunidade, membros, dono atual e calibragem no WHERE —
   se não for pra passar, não passa.

   Passa a PARTIDA, não quem ganhou (migração 17). A versão antiga mandava
   `vencedor` e `perdedor` soltos e o banco acreditava: qualquer membro tomava
   o cinturão pelo console, sem ter jogado. Agora o banco deriva os dois da
   partida — parâmetro que não existe não se forja — e só aceita partida
   posterior ao início do reinado atual. Daí o `m.id` ser obrigatório aqui. */
async function _cinturaoTentarPassar(m){
  if(!m || !m.id || !m.esporte) return;
  /* (mig 48) DUPLAS NÃO TEM CINTURÃO (31/07). O banco já não conta duplas como
     defesa; aqui o app para de PEDIR a passagem — `vencedor`/`perdedor` abaixo
     são derivados de dois jogadores e não descrevem um time. Pedir e ser
     recusado em silêncio funcionaria, mas ensinaria que a chamada é inofensiva
     e esconderia o dia em que ela deixasse de ser. */
  if(m.dupla) return;
  const vc = !!m.venceu_criador;
  const vencedor = vc ? m.criador_id : m.adversario_id;
  const perdedor = vc ? m.adversario_id : m.criador_id;
  try{
    const gs = (await sb.from('grupos').select('id,nome')
      .eq('cinturao', true).eq('esporte', m.esporte)
      .eq('cinturao_dono_id', perdedor)).data || [];
    for(const g of gs){
      const r = await sb.rpc('cinturao_passar', { g:g.id, mid:m.id });
      if(r && r.data === true && window.toast){
        toast(vencedor === MEU_UID
          ? `🏆 O cinturão do <b>${g.nome}</b> é seu.`
          : `O cinturão do <b>${g.nome}</b> mudou de mão.`);
      }
    }
  }catch(e){ /* cinturão nunca derruba a confirmação do placar */ }
}

// -- criar comunidade --
function netCriarGrupoUI(){
  _gnew = _gnew || { nome:'', esporte:(typeof S!=='undefined'&&S.esporte)||'tenis', aberto:false };
  const seg=(campo,ops)=>ops.map(([v,n])=>`<button onclick="_net.gset('${campo}','${v}')" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--linha2);font:600 13px system-ui;cursor:pointer;background:${_gnew[campo]==v?'#2C5A00':'var(--sup2)'};color:#fff">${n}</button>`).join('');
  _sheet('net-gnew', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Criar comunidade</div>
      <button onclick="_net.fecharGnew()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <input id="gn-nome" value="${(_gnew.nome||'').replace(/"/g,'&quot;')}" oninput="_net.gset('nome',this.value)" placeholder="Nome da comunidade" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;margin-top:12px" autocomplete="off"/>
    <div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Esporte</div><div style="display:flex;gap:8px">${seg('esporte',[['tenis','Tênis'],['beach','Beach']])}</div>
    <div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Quem acha a comunidade</div><div style="display:flex;gap:8px">${seg('aberto',[[false,'Fechado (só convite)'],[true,'Aberto (aceita pedidos)']])}</div>
    <div style="font-size:11px;color:var(--ink3);margin-top:6px">Aberto = aparece na lista e qualquer um pode <b>pedir</b> pra entrar; você aprova. Fechado = só entra pelo link de convite.</div>
    ${(_locais&&_locais.length)?`<div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">📍 Onde joga <span style="color:var(--ink3)">(opcional)</span></div>
    <select onchange="_net.gset('local_id',this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">
      <option value="" ${!_gnew.local_id?'selected':''}>Sem casa fixa</option>
      ${_locais.map(l=>`<option value="${l.id}" ${_gnew.local_id===l.id?'selected':''}>${l.nome}</option>`).join('')}
    </select>`:''}
    <button onclick="_net.gcriar()" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:18px">Criar comunidade</button>`);
  const el=document.getElementById('gn-nome'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); }
}
function _gset(campo,v){ if(v==='true')v=true; if(v==='false')v=false; _gnew[campo]=v; if(campo!=='nome') netCriarGrupoUI(); }
async function _gcriar(){
  if(!_gnew.nome || !_gnew.nome.trim()){ alert('Dá um nome pra comunidade.'); return; }
  try{ if(window.netSyncJogador && typeof S!=='undefined') await netSyncJogador(S.jogadores[EU]); }catch(e){}
  const { data, error } = await sb.from('grupos').insert({ nome:_gnew.nome, dono_id:MEU_UID, esporte:_gnew.esporte, aberto:!!_gnew.aberto, local_id:_gnew.local_id||null }).select().single();
  if(error){ alert('Erro ao criar: '+error.message); return; }
  await sb.from('grupo_membros').insert({ grupo_id:data.id, player_id:MEU_UID, papel:'dono' });
  _gnew=null; const el=document.getElementById('net-gnew'); if(el) el.remove();
  if(window.toast) toast('Comunidade criada! Manda o link pros amigos.');
  netMeusQuadros(true).catch(()=>{});   // entrou uma comunidade: o quadro muda
  netVerGrupo(data.id);
}
function netFecharGnew(){ _gnew=null; const el=document.getElementById('net-gnew'); if(el) el.remove(); }

// -- pedir pra entrar (upsert cobre o re-pedido depois de recusado) --
async function netPedirEntrar(gid){
  try{ if(window.netSyncJogador && typeof S!=='undefined') await netSyncJogador(S.jogadores[EU]); }catch(e){}
  const { error } = await sb.from('grupo_pedidos').upsert({ grupo_id:gid, player_id:MEU_UID, estado:'pendente' });
  if(error){ alert('Erro ao pedir: '+error.message); return; }
  if(window.toast) toast('Pedido enviado. O gestor da comunidade aprova.');
  // atualiza a tela de onde o pedido saiu (detalhe ou lista)
  if(document.getElementById('net-gver')) netVerGrupo(gid); else netAbrirGrupos();
}

// -- detalhe do grupo: membros, pedidos (gestor), papéis, link --
async function netVerGrupo(gid){
  const g=(await sb.from('grupos').select('*').eq('id',gid).maybeSingle()).data;
  if(!g){ alert('Comunidade não encontrada.'); return; }
  const ms=(await sb.from('grupo_membros').select('player_id,papel').eq('grupo_id',gid)).data||[];
  if(window.aplicarJogadoresReais && ms.some(p=>!S.jogadores[_chaveLocal(p.player_id)])){ try{ window.aplicarJogadoresReais(await netAdversarios()); }catch(e){} }
  const meu=ms.find(p=>p.player_id===MEU_UID);
  const souDono=g.dono_id===MEU_UID, souGestor=souDono||(meu&&meu.papel==='admin');
  /* Ranking da comunidade — agora é o que a decisão de 09/08 descreve: alimentado
     pelas PARTIDAS ENTRE MEMBROS, somando o livro-caixa no escopo da comunidade.
     Antes ordenava por Nível, que conta partida contra qualquer um e por isso
     media outra coisa. Nível fica de desempate: no começo da temporada todo
     mundo tem 0 ponto e sem critério a lista sairia aleatória. */
  const nvq=(await sb.from('players').select('id,nivel,nivelb').in('id',ms.map(p=>p.player_id))).data||[];
  const nivelG={}; nvq.forEach(p=>nivelG[p.id]= g.esporte==='beach'?(p.nivelb??1200):(p.nivel??1200));
  const ptsG = await netRanking('grupo:'+gid, g.esporte);
  /* 18/08 (mig 39): V/D, saldo de games e as últimas 3, vindos do agregado —
     a `quadro_stats` lê as partidas por baixo da RLS e devolve só os números.
     Falha aqui NÃO derruba a tela: o quadro sempre existiu sem essas colunas,
     então erro vira colunas ausentes, não comunidade inacessível. */
  const statsG = {};
  try{
    const st = await sb.rpc('quadro_stats', { p_grupo: gid, p_esporte: g.esporte||'tenis' });
    if(st.error) console.error('[net] quadro_stats', st.error);
    else (st.data||[]).forEach(s=> statsG[s.player_id]=s);
  }catch(e){ console.error('[net] quadro_stats', e); }
  ms.sort((a,b)=> ((ptsG[b.player_id]||0)-(ptsG[a.player_id]||0))
                || ((nivelG[b.player_id]||0)-(nivelG[a.player_id]||0)));
  const linha=(p,i)=>{
    const ehDono=p.player_id===g.dono_id;
    // ações de gestão: dono promove/rebaixa admin; gestor remove membro comum
    let acoes='';
    if(p.player_id!==MEU_UID && !ehDono){
      if(souDono) acoes += p.papel==='admin'
        ? `<button onclick="_net.mudarPapel('${gid}','${p.player_id}','membro')" style="padding:5px 8px;border-radius:8px;border:1px solid var(--linha2);background:var(--sup2);color:var(--ink2);font:600 10px system-ui;cursor:pointer">tirar admin</button>`
        : `<button onclick="_net.mudarPapel('${gid}','${p.player_id}','admin')" style="padding:5px 8px;border-radius:8px;border:1px solid var(--linha2);background:var(--sup2);color:var(--ink2);font:600 10px system-ui;cursor:pointer">virar admin</button>`;
      if(souGestor && p.papel!=='admin') acoes += ` <button onclick="_net.removerMembro('${gid}','${p.player_id}')" style="padding:5px 8px;border-radius:8px;border:1px solid var(--dn-bg);background:var(--dn-bg);color:var(--ink2);font:600 10px system-ui;cursor:pointer">remover</button>`;
    }
    /* as colunas da 39. `st` ausente é gente que nunca teve partida confirmada
       neste esporte — a linha diz só pontos e Nível, como sempre disse, em vez
       de inventar um 0×0 que parece resultado. As três bolinhas são as últimas
       partidas, a mais recente primeiro. */
    const st = statsG[p.player_id];
    const ultimas = st && st.ultimas
      ? ' · ' + st.ultimas.split('').map(r=>`<span style="color:${r==='V'?'var(--up)':'var(--dn)'}">${r==='V'?'●':'○'}</span>`).join('')
      : '';
    const colunas = st
      ? `<div style="font-size:11px;color:var(--ink2)"><b style="color:var(--up)">${st.vitorias}V</b> <b style="color:var(--dn)">${st.derrotas}D</b> · games ${st.sets_pro>=st.sets_contra?'+':''}${st.sets_pro-st.sets_contra}${ultimas}</div>`
      : '';
    return `<div style="display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--sup2)">
      <div style="width:22px;text-align:center;font:700 12px system-ui;color:${i===0?'var(--gold)':'var(--ink2)'};flex:0 0 22px">${i+1}º</div>
      ${_discoUid(p.player_id, 28)}
      <div style="flex:1;min-width:0"><b>${_nomeDe(p.player_id)}</b>
        ${ehDono?'<span style="color:var(--gold);font-size:11px"> dono</span>':p.papel==='admin'?'<span style="color:var(--up);font-size:11px"> admin</span>':''}
        <div style="font-size:11px;color:var(--ink2)"><b style="color:var(--up)">${ptsG[p.player_id]||0}</b> pts · Nível ${nivelG[p.player_id]??'—'}</div>
        ${colunas}</div>
      ${acoes}</div>`;
  };
  // pedidos pendentes — só o gestor vê
  let pedidosH='';
  if(souGestor){
    const ps=(await sb.from('grupo_pedidos').select('player_id,estado').eq('grupo_id',gid).eq('estado','pendente')).data||[];
    if(ps.length){
      if(window.aplicarJogadoresReais && ps.some(p=>!S.jogadores[_chaveLocal(p.player_id)])){ try{ window.aplicarJogadoresReais(await netAdversarios()); }catch(e){} }
      pedidosH = `<div style="font:700 12px system-ui;color:var(--gold);margin-top:14px;text-transform:uppercase;letter-spacing:.08em">Pedidos pra entrar</div>`
        + ps.map(p=>`<div style="display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--sup2)">
            <div style="flex:1"><b>${_nomeDe(p.player_id)}</b> <span style="color:var(--ink3);font-size:11px">${netId(p.player_id)}</span></div>
            <button onclick="_net.aceitarPedido('${gid}','${p.player_id}')" style="padding:7px 12px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Aceitar</button>
            <button onclick="_net.recusarPedido('${gid}','${p.player_id}')" style="padding:7px 12px;border-radius:9px;border:1px solid var(--dn-bg);background:var(--dn-bg);color:#fff;font:600 12px system-ui;cursor:pointer">Recusar</button>
          </div>`).join('')
        + `<div style="font-size:11px;color:var(--ink3);margin-top:6px">Recusar não custa nada — quem pediu só vê que não rolou, sem aviso nem motivo.</div>`;
    }
  }
  // não-membro: pedir pra entrar direto do detalhe (com o estado do pedido)
  let entrar='';
  if(!meu){
    const pd=(await sb.from('grupo_pedidos').select('estado').eq('grupo_id',gid).eq('player_id',MEU_UID).maybeSingle()).data;
    entrar = (pd&&pd.estado==='pendente')
      ? `<div style="text-align:center;color:var(--gold);font-size:13px;margin-top:14px">Pedido enviado — aguardando o gestor aprovar.</div>`
      : `<button onclick="_net.pedirEntrar('${gid}')" style="width:100%;padding:12px;border-radius:11px;border:none;background:#2C5A00;color:#fff;font:700 13px system-ui;cursor:pointer;margin-top:14px">${(pd&&pd.estado==='recusado')?'Não rolou · pedir de novo':'Pedir pra entrar'}</button>`;
  }
  /* 18/08 (mig 37): a conversa. Vem ANTES dos patches de propósito — é o que
     traz a pessoa de volta à comunidade no dia em que ela não jogou, e a folha
     se lê de cima pra baixo. Só membro vê o botão porque só membro atravessa a
     policy: oferecer a porta pra quem a fechadura vai negar é oferecer um erro. */
  const nrec = netRecadosDe('grupo', gid);   // (51) "· N novas" traz de volta quem não jogou
  const chatBtn = meu ? `<button onclick="_net.abrirChat('${gid}')" style="width:100%;padding:12px;border-radius:11px;border:1px solid ${nrec?'var(--up)':'var(--linha2)'};background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:14px">💬 Conversa da comunidade${nrec?` · <b style="color:var(--up)">${nrec} nova${nrec===1?'':'s'}</b>`:''}</button>` : '';
  // patches da comunidade (migração 22) — todo membro cria e manda
  const patchesBtn = meu ? `<button onclick="_net.abrirPatches('${gid}')" style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:10px">◈ Patches da comunidade — criar e mandar</button>` : '';
  const sair = (meu && !souDono) ? `<button onclick="_net.sairGrupo('${gid}')" style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--dn-bg);background:var(--dn-bg);color:#fff;font:600 13px system-ui;cursor:pointer;margin-top:14px">Sair da comunidade</button>` : '';
  const link = souGestor ? `<button onclick="_net.copiarLinkGrupo('${gid}')" style="width:100%;padding:12px;border-radius:11px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:10px">🔗 Copiar link de convite</button>
    <div style="font-size:11px;color:var(--ink3);text-align:center;margin-top:6px">O link é o seu convite: quem abrir entra direto, sem pedido.</div>
    ${souDono?`<button onclick="_net.revogarLink('${gid}')" style="width:100%;padding:10px;border-radius:11px;border:none;background:none;color:var(--ink2);font:600 12px system-ui;cursor:pointer;margin-top:4px;text-decoration:underline">Revogar link (o antigo para de funcionar)</button>`:''}` : '';
  /* ---- cinturão ----
     O reinado só significa alguma coisa se estiver na cara: quem tem, há
     quanto tempo e quantas defesas. Regra que só existe no documento não muda
     comportamento. */
  let cinturaoH = '';
  const est = await _cinturaoEstado(g, ms);
  if(est && est.vencido && !_expirando[gid]){
    // 30 dias parado: o banco reconfere e entrega pro 1º. Guarda de reentrada
    // porque isto re-renderiza a tela.
    _expirando[gid] = 1;
    const r = await sb.rpc('cinturao_expirar', { g:gid });
    delete _expirando[gid];
    if(r && r.data === true){ netVerGrupo(gid); return; }
  }
  if(est){
    const souEu = est.dono === MEU_UID;
    const selo = est.congelado ? 'var(--ink3)' : 'var(--gold)';
    const etiqueta = est.congelado
      ? `<span style="color:var(--dn)">reinado congelado</span> · ${est.parado} dias sem jogar`
      : `<b>${est.dias}</b> ${est.dias===1?'dia':'dias'} de reinado · <b>${est.defesas}</b> ${est.defesas===1?'defesa':'defesas'}`;
    cinturaoH = `<div style="display:flex;gap:11px;align-items:center;margin:12px 0 4px;padding:12px;
        border-radius:12px;border:1px solid ${est.congelado?'var(--linha2)':'var(--gold-bg)'};background:${est.congelado?'var(--sup)':'var(--gold-bg)'}">
      <div style="font-size:26px;line-height:1;flex:0 0 auto;filter:${est.congelado?'grayscale(1) opacity(.6)':'none'}">🥇</div>
      <div style="flex:1;min-width:0">
        <div style="font:700 13px system-ui;color:${selo}">${souEu?'Você tem o cinturão':_nomeDe(est.dono)}</div>
        <div style="font-size:11px;color:var(--ink2);margin-top:2px">${etiqueta}</div>
      </div></div>
      <div style="font-size:11px;color:var(--ink3);margin-bottom:10px">
        Passa pra quem vencer ${souEu?'você':'quem tem'} numa partida normal — sem desafio, sem marcar nada.
        ${est.congelado?'Aos 30 dias parado o cinturão vai pro 1º da comunidade.':'Parar 14 dias congela o reinado.'}</div>`;
  } else if(g.cinturao){
    cinturaoH = `<div style="margin:12px 0;padding:12px;border-radius:12px;border:1px dashed var(--linha2);background:var(--sup)">
      <div style="font:700 13px system-ui;color:var(--gold)">🥇 Cinturão vago</div>
      <div style="font-size:11px;color:var(--ink2);margin-top:3px">Ninguém tem. O gestor precisa entregar pra alguém.</div></div>`;
  } else if(souGestor){
    cinturaoH = `<button onclick="_net.ligarCinturao('${gid}')" style="width:100%;padding:11px;border-radius:11px;
        border:1px dashed var(--gold-bg);background:var(--sup);color:var(--gold);font:600 13px system-ui;cursor:pointer;margin:12px 0 4px">
        🥇 Ligar o cinturão da comunidade</button>
      <div style="font-size:11px;color:var(--ink3);margin-bottom:8px">
        Um por comunidade, no ${g.esporte==='beach'?'beach':'tênis'}. Nasce com você e passa pra quem te vencer.</div>`;
  }

  // casa da comunidade (migração 19): todo mundo vê no cabeçalho; o gestor
  // define/troca aqui — a policy grupos_upd já limita a escrita a ele
  const casaH = (souGestor && _locais && _locais.length) ? `
    <div style="display:flex;align-items:center;gap:8px;margin:0 0 12px">
      <span style="font-size:12px;color:var(--ink2);flex:0 0 auto">📍 Casa</span>
      <select onchange="_net.gcasa('${gid}',this.value)" style="flex:1;padding:9px;border-radius:10px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 12px system-ui">
        <option value="" ${!g.local_id?'selected':''}>Sem casa fixa</option>
        ${_locais.map(l=>`<option value="${l.id}" ${g.local_id===l.id?'selected':''}>${l.nome}</option>`).join('')}
      </select></div>` : '';
  _sheet('net-gver', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">${g.nome}</div>
      <button onclick="_net.fecharGver()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 12px">${g.esporte==='beach'?'Beach':'Tênis'} · ${ms.length} membros · ${g.aberto?'aberto':'fechado'}${g.local_id&&_locNome(g.local_id)?' · 📍 '+_locNome(g.local_id):''}</div>
    ${casaH}
    ${cinturaoH}
    ${ms.map(linha).join('')||'<p style="color:var(--ink2);font-size:13px">Ninguém ainda.</p>'}
    ${pedidosH}${entrar}${chatBtn}${patchesBtn}${sair}${link}`);
}
function netFecharGver(){ const el=document.getElementById('net-gver'); if(el) el.remove(); }

/* =========================================================================
   A CONVERSA DA COMUNIDADE (18/08, migração 37)
   Folha própria e não bloco dentro do `net-gver`: aquela já carrega ranking,
   cinturão, pedidos, patches, casa, convite e sair. Conversa empilhada ali
   embaixo nasceria abaixo da dobra, que é o mesmo que não existir.

   ⚠️ TODO texto de mensagem passa por `_admEsc`. É o primeiro campo do app onde
   alguém escreve texto longo e livre, e o banco guarda cru de propósito — quem
   transforma em HTML é esta tela. Interpolar direto aqui é um XSS de uma linha.
   ========================================================================= */
let _chat = null;

/* 18/08 (mig 40): a MESMA folha serve às duas salas — a da comunidade (37) e a
   da partida (40). O que muda é a tabela, a coluna da sala e quem pode apagar;
   o render, o envio, o carimbo de hora e o escape são um só. `_chat.sala`
   guarda os três, e o resto do código pergunta a ele em vez de saber. */
const _SALAS = {
  grupo:   { tabela:'grupo_mensagens',   coluna:'grupo_id', titulo:'Conversa' },
  partida: { tabela:'partida_mensagens', coluna:'match_id', titulo:'Combinar' },
};

async function netAbrirChat(gid){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  _chat = { sala:_SALAS.grupo, id:gid, nome:'', msgs:[], rascunho:'', carregando:true, aberta:true };
  netRenderChat();
  const g = (await sb.from('grupos').select('nome,dono_id').eq('id',gid).maybeSingle()).data;
  if(!g){ netFecharChat(); alert('Comunidade não encontrada.'); return; }
  _chat.nome = g.nome; _chat.dono_id = g.dono_id;
  await _chatCarregar();
}

/* A conversa da partida. `aberta` é o que a policy `partida_msg_ins` cobra —
   status vivo — e a tela precisa saber ANTES de oferecer o campo: partida
   confirmada ainda deixa ler, mas escrever seria oferecer um erro. O nome da
   sala é o do outro, porque a sala é a partida e a partida é com ele. */
async function netAbrirChatPartida(matchId){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const m = _inbox.find(x=>x.id===matchId)
         || (await sb.from('matches').select('id,criador_id,adversario_id,status').eq('id',matchId).maybeSingle()).data;
  if(!m){ alert('Partida não encontrada.'); return; }
  const aberta = ['desafiado','aceito','pendente'].includes(m.status);
  _chat = { sala:_SALAS.partida, id:matchId, nome:_nomeDe(_advId(m)), msgs:[], rascunho:'',
            carregando:true, aberta, dono_id:null };
  netRenderChat();
  await _chatCarregar();
}

/* Busca as mais NOVAS e inverte pra desenhar: a conversa se lê de cima pra
   baixo, mas o que interessa é o fim. Pedir `criado_em asc` com limit traria as
   50 PRIMEIRAS mensagens da sala — as de meses atrás. */
async function _chatCarregar(){
  if(!_chat) return;
  const r = await sb.from(_chat.sala.tabela)
    .select('id,autor_id,texto,criado_em')
    .eq(_chat.sala.coluna, _chat.id)
    .order('criado_em', {ascending:false})
    .limit(50);
  if(!_chat) return;                       // fechou enquanto a consulta voltava
  if(r.error){
    console.error('[net] chat', r.error);
    _chat.erro = r.error.message; _chat.carregando = false; netRenderChat(); return;
  }
  _chat.msgs = (r.data||[]).slice().reverse();
  _chat.carregando = false;
  /* autor que não está no elenco local viraria "Jogador" — acontece com quem
     saiu da comunidade e deixou o que escreveu. Mesmo remendo do inbox. */
  const faltando = _chat.msgs.some(m=> !S.jogadores[_chaveLocal(m.autor_id)]);
  if(faltando && window.aplicarJogadoresReais){
    try{ window.aplicarJogadoresReais(await netAdversarios()); }catch(e){}
  }
  netRenderChat();
  /* li até aqui: quem viu as mensagens carimba (mig 51). Carregar É ver — a
     folha desenha tudo o que veio. */
  _salaCarimbar(_chat);
}

function netFecharChat(){
  const c=_chat;
  _chat=null; const el=document.getElementById('net-chat'); if(el) el.remove();
  // carimba de novo ao fechar: cobre a resposta que entrou no reload do meu envio
  if(c) _salaCarimbar(c);
}
function _chatDigitou(v){ if(_chat) _chat.rascunho = v; }   // sem re-render: perderia o cursor

/* ---- AS SALAS AVISAM (migração 51) --------------------------------------
   O carimbo "até onde eu li" vive na `sala_lida`, e o número de não lidas sai
   da `avisos_salas()` — a tela NUNCA inventa nem zera o ponto por conta
   própria. O `S.novidades=0` do `trocarAba` é o exemplo do que NÃO copiar
   aqui: um zero local morre no reload e mente no segundo aparelho.

   O carimbo não é `now()`: é o `criado_em` da última mensagem CARREGADA.
   Relógio de cliente torto não entra na conta, e mensagem que chegou no banco
   depois do meu load continua não lida — porque eu não a vi mesmo. */
async function _salaCarimbar(c){
  if(!c || !MEU_UID || !c.msgs || !c.msgs.length) return;
  const ultima = c.msgs[c.msgs.length-1].criado_em;
  try{
    const { error } = await sb.from('sala_lida').upsert({
      player_id: MEU_UID,
      sala: c.sala===_SALAS.grupo ? 'grupo' : 'partida',
      sala_id: c.id,
      lido_em: ultima,
    });
    if(!error) netAvisos();   // o ponto apaga vindo do banco, não daqui
  }catch(e){}
}

/* Três batidas: boot (via o inbox do boot), fim de cada `netAtualizarInbox` e
   `visibilitychange` (no index.html, junto do `conferirVersao`). Em erro de
   rede o `_avisos` anterior FICA — badge que zera em erro vira badge em que
   ninguém acredita. */
let _avisos = null;   // null = nunca carregou; {grupo:{id:n}, partida:{id:n}}
async function netAvisos(){
  if(!MEU_UID) return;
  const { data, error } = await sb.rpc('avisos_salas');
  if(error){ console.error('[net] avisos', error); return; }   // mantém o último valor
  const av = { grupo:{}, partida:{} };
  (data||[]).forEach(r=>{ if(av[r.sala]) av[r.sala][r.sala_id] = r.nao_lidas; });
  _avisos = av;
  if(window.render) render();
  if(document.getElementById('net-inbox')) netRenderInbox();
}
function netRecadosDe(tipo, id){ return (_avisos && _avisos[tipo] && _avisos[tipo][id]) || 0; }
function netTemRecado(tipo){
  if(!_avisos) return false;
  return (tipo ? [tipo] : ['grupo','partida'])
    .some(t=> Object.values(_avisos[t]).some(n=> n>0));
}

/* 25/08 (mig 66): AULAS — a REGRA, não a lista.
   O banco guarda "terça 18h, esses alunos". As ocorrências de cada semana são
   calculadas no cliente a partir da regra, menos as exceções. Nada de gravar
   uma linha por semana: além de virar lixo, faria o professor remarcar as
   mesmas aulas toda segunda e desistir do app na terceira. */
async function netAulas(){
  if(!MEU_UID) return [];
  const { data, error } = await sb.from('aulas')
    .select('*, aula_alunos(aluno_id), aula_excecoes(dia, motivo)')
    .eq('ativa', true).order('dia_semana').order('hora');
  if(error){ console.error('[net] aulas', error); return null; }
  return data || [];
}
async function netAulaCriar(d){
  if(!MEU_UID) return { erro:'sem conta' };
  const { data, error } = await sb.from('aulas').insert({
    professor_id: MEU_UID, dia_semana: d.dia_semana, hora: d.hora,
    duracao_min: d.duracao_min || 60,
    local_id: d.local_id || null, local_txt: (d.local_txt||'').trim() || null,
    esporte: d.esporte || 'tenis',
  }).select('id').maybeSingle();
  return { id: data ? data.id : null, erro: error ? error.message : null };
}
/* desligar é `ativa=false`, nunca delete: a aula sai de circulação e o
   histórico de quem passou por ela continua de pé */
async function netAulaDesligar(id){
  const { error } = await sb.from('aulas').update({ ativa:false }).eq('id', id);
  return { erro: error ? error.message : null };
}
async function netAulaAluno(aulaId, alunoId, entra){
  const q = entra
    ? sb.from('aula_alunos').insert({ aula_id: aulaId, aluno_id: alunoId })
    : sb.from('aula_alunos').delete().eq('aula_id', aulaId).eq('aluno_id', alunoId);
  const { error } = await q;
  return { erro: error ? error.message : null };
}
/* o cancelamento pontual: "esta terça não tem" */
async function netAulaCancelar(aulaId, dia, motivo){
  const { error } = await sb.from('aula_excecoes')
    .insert({ aula_id: aulaId, dia, motivo: (motivo||'').trim() || null });
  return { erro: error ? error.message : null };
}
async function netAulaDescancelar(aulaId, dia){
  const { error } = await sb.from('aula_excecoes').delete().eq('aula_id', aulaId).eq('dia', dia);
  return { erro: error ? error.message : null };
}
window.netAulas=netAulas;

/* A TURMA como grupo (mig 66): cria uma vez e fica pendurada no professor. */
async function netTurmaCriar(nome){
  if(!MEU_UID) return { erro:'sem conta' };
  const g = await sb.from('grupos').insert({ nome: (nome||'Minha turma').trim(), dono_id: MEU_UID })
    .select('id').maybeSingle();
  if(g.error) return { erro: g.error.message };
  await sb.from('grupo_membros').insert({ grupo_id: g.data.id, player_id: MEU_UID, papel: 'dono' });
  const up = await sb.from('professores').update({ turma_grupo_id: g.data.id }).eq('player_id', MEU_UID);
  return { id: g.data.id, erro: up.error ? up.error.message : null };
}
/* a evolução dos alunos — o que o professor mostra pro pai do aluno */
async function netAlunosDetalhe(){
  if(!MEU_UID) return [];
  const v = await sb.from('alunos').select('aluno_id, esporte, desde')
    .eq('treinador_id', MEU_UID).is('encerrado_em', null);
  if(v.error){ console.error('[net] alunos detalhe', v.error); return []; }
  const ids = [...new Set((v.data||[]).map(x=>x.aluno_id))];
  if(!ids.length) return [];
  const p = await sb.from('players').select('id, nome, nivel, nivelb, calibrando, cal').in('id', ids);
  const mapa = {}; (p.data||[]).forEach(x=> mapa[x.id]=x);
  return (v.data||[]).map(x=> ({ ...x, jogador: mapa[x.aluno_id] || null }));
}
window.netAlunosDetalhe=netAlunosDetalhe;

/* 25/08 (mig 65): A MEDIÇÃO DO ESPAÇO DE MÍDIA.
   O motor de anúncio (19/08) nasceu com o gancho `_adsEvento` escrito e sem
   banco atrás — dava pra vender a primeira vez e não pra renovar, porque na
   renovação o anunciante pergunta quanta gente viu. A reunião de 25/08 tornou
   isso bloqueio: a monetização de curto prazo é CPM, que é preço POR MIL
   IMPRESSÕES.

   FALHA EM SILÊNCIO, DE PROPÓSITO: medir é secundário ao app funcionar. Se a
   escrita não for, o banner continua na tela e ninguém vê erro — o oposto
   também seria verdade (app que quebra porque a métrica falhou é métrica
   mandando no produto). */
async function netAdsEvento(tipo, campanha){
  if(!MEU_UID || !campanha) return;
  try{
    /* `dia` e `player_id` vão preenchidos e são SOBRESCRITOS pelo trigger — o
       cliente não escolhe nem o dia nem o autor. Mandar mesmo assim mantém o
       insert válido se alguém rodar isto contra um banco sem a 65. */
    await sb.from('ads_eventos').insert({
      campanha: String(campanha).slice(0,60), tipo,
      dia: new Date().toISOString().slice(0,10), player_id: MEU_UID,
    });
  }catch(e){ /* silêncio: ver nota acima */ }
}
window.netAdsEvento = netAdsEvento;

/* O relatório — só o ADM recebe linha (a porta está DENTRO da função, mig 65).
   Quem não é ADM recebe zero linhas, não erro. */
async function netAdsRelatorio(desde){
  const { data, error } = await sb.rpc('ads_relatorio', { p_desde: desde || null });
  if(error){ console.error('[net] ads relatorio', error); return null; }
  return data || [];
}
window.netAdsRelatorio = netAdsRelatorio;

/* 25/08 (mig 62): PROFESSORES E TURMA.
   `professores` é IDENTIDADE (quem se declara), `plano='treinador'` é camada
   comercial. O vínculo com aluno passa SEMPRE pelas RPCs: `alunos` não tem
   policy de escrita, porque quem recebe bonificação não preenche a lista. */
async function netProfessores(){
  const { data, error } = await sb.from('professores')
    .select('player_id, contato, apresentacao, aceitando_ate, ativo')
    .eq('ativo', true);
  if(error){ console.error('[net] professores', error); return null; }
  return data || [];
}
async function netMeuProfessor(){
  if(!MEU_UID) return null;
  const { data } = await sb.from('professores').select('*').eq('player_id', MEU_UID).maybeSingle();
  return data || null;
}
async function netSalvarProfessor(d){
  if(!MEU_UID) return {erro:'sem conta'};
  const linha = { player_id: MEU_UID, ativo: d.ativo !== false,
    contato: (d.contato||'').trim() || null,
    apresentacao: (d.apresentacao||'').trim() || null,
    aceitando_ate: d.aceitandoAte || null };
  const { error } = await sb.from('professores').upsert(linha);
  return { erro: error ? error.message : null };
}
/* a turma: quem é meu aluno, quem é meu professor, e o que está pendente */
async function netTurma(){
  if(!MEU_UID) return {alunos:[], professores:[], pedidos:[]};
  const [a, pd] = await Promise.all([
    sb.from('alunos').select('*').is('encerrado_em', null),
    sb.from('aluno_pedidos').select('*').eq('estado','pendente'),
  ]);
  if(a.error) console.error('[net] turma', a.error);
  const linhas = a.data || [];
  return {
    alunos:      linhas.filter(x=> x.treinador_id === MEU_UID),
    professores: linhas.filter(x=> x.aluno_id     === MEU_UID),
    pedidos:     (pd.data || []),
  };
}
async function netAlunoPedir(outro, esporte){
  const { data, error } = await sb.rpc('aluno_pedir', { p_outro: outro, p_esporte: esporte || 'tenis' });
  return { msg: data, erro: error ? error.message : null };
}
async function netAlunoAceitar(outro, esporte){
  const { data, error } = await sb.rpc('aluno_aceitar', { p_outro: outro, p_esporte: esporte || 'tenis' });
  return { ok: !!data, erro: error ? error.message : null };
}
async function netAlunoRecusar(outro, esporte){
  const { error } = await sb.rpc('aluno_recusar', { p_outro: outro, p_esporte: esporte || 'tenis' });
  return { erro: error ? error.message : null };
}
async function netAlunoEncerrar(outro, esporte){
  const { error } = await sb.rpc('aluno_encerrar', { p_outro: outro, p_esporte: esporte || 'tenis' });
  return { erro: error ? error.message : null };
}
window.netProfessores=netProfessores; window.netMeuProfessor=netMeuProfessor;
window.netSalvarProfessor=netSalvarProfessor; window.netTurma=netTurma;

/* 25/08 (mig 59+62): O PAINEL DO ADM sobre um lugar — telefone e locação.
   Estas duas colunas existiam e NENHUMA tela escrevia nelas: o pedido do Rege
   de "manter o contato atualizado" não tinha como acontecer. */
async function netSalvarLugar(id, campos){
  const { error } = await sb.from('locais').update(campos).eq('id', id);
  if(!error) _locais = null;                 // força recarregar o cache
  return { erro: error ? error.message : null };
}
/* cadastro de torneio EXTERNO — só o ADM passa (policy torn_ins, mig 59) */
async function netCriarTorneioExterno(d){
  const { data, error } = await sb.from('torneios').insert({
    nome: d.nome, modo: 'externo', esporte: d.esporte || 'tenis',
    cidade_id: d.cidade_id, local_txt: d.local_txt || null,
    organizador: d.organizador || null, site: d.site || null,
    comeca_em: d.comeca_em, termina_em: d.termina_em || d.comeca_em,
    publicado_em: d.publicar ? new Date().toISOString() : null,
    status: 'inscricoes', aberto: true,
  }).select('id').maybeSingle();
  return { id: data ? data.id : null, erro: error ? error.message : null };
}
async function netCidades(){
  const { data } = await sb.from('cidades').select('id,nome,uf').order('nome');
  return data || [];
}
window.netSalvarLugar=netSalvarLugar; window.netCriarTorneioExterno=netCriarTorneioExterno;

/* 25/08 (mig 59): A AGENDA. Mesma função que a vitrine pública vai chamar —
   `agenda_publica` é security definer e devolve só o que já é público no
   cartaz do organizador. De dentro do app ela vale pelo mesmo motivo: evita
   uma segunda consulta que teria de repetir as regras de quem enxerga o quê. */
async function netAgenda(diasAtras){
  const { data, error } = await sb.rpc('agenda_publica', { p_dias_atras: diasAtras ?? 120 });
  if(error){ console.error('[net] agenda', error); return null; }
  return data || [];
}
window.netAgenda = netAgenda;

/* 25/08 (mig 55): CONVITE E PORTEIRA. As três portas são RPC, não tabela — a
   porteira roda antes de existir conta, e policy de select pra anon deixaria
   qualquer um listar os códigos. `validar` responde só sim/não de propósito. */
async function netConviteValidar(codigo){
  const { data, error } = await sb.rpc('convite_validar', { p_codigo: codigo });
  if(error){ console.error('[net] convite validar', error); return { erro: error.message }; }
  return { valido: !!data };
}
async function netConviteConsumir(codigo){
  const { data, error } = await sb.rpc('convite_consumir', { p_codigo: codigo });
  if(error){ console.error('[net] convite consumir', error); return { erro: error.message }; }
  return { ok: !!data };
}
async function netConviteGerar(){
  const { data, error } = await sb.rpc('convite_gerar');
  if(error) return { erro: error.message };
  return { codigo: data };
}
/* Meus convites + quem entrou por eles. O nome de quem usou vem do elenco já
   carregado (`S.jogadores`); sem ele, mostra "alguém" em vez de vazar id. */
async function netMeusConvites(){
  if(!MEU_UID) return [];
  const { data, error } = await sb.from('convites').select('*')
    .eq('dono_id', MEU_UID).order('criado_em', {ascending:false});
  if(error){ console.error('[net] meus convites', error); return []; }
  return data||[];
}
async function netInteressado(nome, contato, cidade){
  const { error } = await sb.from('interessados').insert({
    nome:(nome||'').trim(), contato:(contato||'').trim(), cidade:(cidade||'').trim() });
  return { erro: error ? error.message : null };
}
window.netConviteValidar=netConviteValidar; window.netConviteConsumir=netConviteConsumir;
window.netConviteGerar=netConviteGerar;     window.netMeusConvites=netMeusConvites;
window.netInteressado=netInteressado;

/* 25/08 (mig 54): DISPONIBILIDADES — slots de "estou livre" com data+hora e
   preferências. O princípio de 18/08 segue: sinal com validade, nunca boolean.
   Linha do passado não se apaga daqui (é história); o cliente só FILTRA
   `quando > agora`. O guard do banco cuida de futuro/teto/máximo. */
async function netDispMinhas(){
  if(!MEU_UID) return [];
  const { data, error } = await sb.from('disponibilidades').select('*')
    .eq('player_id', MEU_UID).gt('quando', new Date(Date.now()-3600e3).toISOString())
    .order('quando');
  if(error){ console.error('[net] disp minhas', error); return []; }
  return data||[];
}
/* Slots de TODO MUNDO nos próximos 7 dias — vira o mapa playerId→slots que o
   radar usa pras abas Agora/Hoje/Esta semana. 400 de teto: no volume atual é
   folga; quando doer, pagina por cidade. */
async function netDispTodas(){
  if(!MEU_UID) return {};
  const { data, error } = await sb.from('disponibilidades').select('*')
    .gt('quando', new Date(Date.now()-3600e3).toISOString())
    .lt('quando', new Date(Date.now()+7*86400e3).toISOString())
    .order('quando').limit(400);
  if(error){ console.error('[net] disp todas', error); return {}; }
  const mapa={};
  (data||[]).forEach(d=>{ (mapa[d.player_id]=mapa[d.player_id]||[]).push(d); });
  return mapa;
}
async function netDispCriar(slot){
  if(!MEU_UID) return {erro:'sem conta'};
  const { error } = await sb.from('disponibilidades').insert({ ...slot, player_id: MEU_UID });
  return { erro: error ? error.message : null };
}
async function netDispApagar(id){
  if(!MEU_UID) return;
  const { error } = await sb.from('disponibilidades').delete().eq('id', id).eq('player_id', MEU_UID);
  if(error) console.error('[net] disp apagar', error);
}
window.netDispMinhas=netDispMinhas; window.netDispTodas=netDispTodas;
window.netDispCriar=netDispCriar;   window.netDispApagar=netDispApagar;

/* 25/08 (telas novas): a aba Chat da nav precisa listar as conversas que já
   existem — grupo(s) de que sou membro e partidas vivas do inbox. Não cria
   sala nenhuma: só enumera portas pra `abrirChat`/`abrirChatPartida`. */
async function netChatHub(){
  if(!MEU_UID) return {grupos:[], partidas:[]};
  let grupos=[];
  try{
    const gm = await sb.from('grupo_membros').select('grupo_id, grupos(id, nome)').eq('player_id', MEU_UID);
    grupos = (gm.data||[]).map(x=>x.grupos).filter(Boolean);
  }catch(e){ console.error('[net] chatHub grupos', e); }
  // partidas vivas = as que o inbox já mantém; a conversa morre com a partida
  const partidas = (_inbox||[])
    .filter(m=> ['aceito','pendente','contestada'].includes(m.status))
    .map(m=> ({id:m.id, nome:(typeof _nomeDe==='function'? _nomeDe(_advId(m)) : 'Partida')}));
  return {grupos, partidas};
}
window.netChatHub = netChatHub;

async function _chatEnviar(){
  if(!_chat) return;
  const txt = (_chat.rascunho||'').trim();
  if(!txt) return;
  if(txt.length > 500){ alert('A mensagem passa de 500 caracteres.'); return; }
  const campo = document.getElementById('net-chat-in');
  if(campo) campo.disabled = true;                    // trava o toque duplo
  const { error } = await sb.from(_chat.sala.tabela)
    .insert({ [_chat.sala.coluna]:_chat.id, autor_id:MEU_UID, texto:txt });
  if(campo) campo.disabled = false;
  if(error){ alert('Não deu pra enviar: '+error.message); return; }
  _chat.rascunho = '';
  await _chatCarregar();
}

async function _chatApagar(id){
  if(!_chat) return;
  if(!confirm('Apagar esta mensagem? Ela some pra todo mundo.')) return;
  const { error } = await sb.from(_chat.sala.tabela).delete().eq('id', id);
  if(error){ alert('Não deu pra apagar: '+error.message); return; }
  await _chatCarregar();
}

/* "14:32" pra hoje, "sáb 14:32" pra esta semana, "12/08 14:32" pro resto.
   Data absoluta e nunca "há 2 horas": contagem mente nas bordas, e a mesma
   decisão já vale pro card da partida. */
function _chatHora(iso){
  const d = new Date(iso), agora = new Date();
  const p = (n)=>String(n).padStart(2,'0');
  const hm = `${d.getHours()}:${p(d.getMinutes())}`;
  const mesmoDia = d.toDateString() === agora.toDateString();
  if(mesmoDia) return hm;
  const dias = (agora - d) / 864e5;
  if(dias < 7) return `${['dom','seg','ter','qua','qui','sex','sáb'][d.getDay()]} ${hm}`;
  return `${p(d.getDate())}/${p(d.getMonth()+1)} ${hm}`;
}

function netRenderChat(){
  if(!_chat) return;
  const podeApagar = (m)=> m.autor_id===MEU_UID || _chat.dono_id===MEU_UID || window.__ehAdm;
  const bolhas = _chat.msgs.map((m,i)=>{
    const meu = m.autor_id===MEU_UID;
    const anterior = _chat.msgs[i-1];
    // o nome só aparece quando TROCA de autor: repetir em toda linha de uma
    // sequência do mesmo cara é ruído que empurra a conversa pra baixo
    const mostraNome = !meu && (!anterior || anterior.autor_id!==m.autor_id);
    return `<div style="display:flex;flex-direction:column;align-items:${meu?'flex-end':'flex-start'};margin-top:${mostraNome?'12px':'4px'}">
      ${mostraNome?`<div style="font-size:10.5px;color:var(--ink3);margin:0 0 3px 10px">${_admEsc(_nomeDe(m.autor_id))}</div>`:''}
      <div style="max-width:82%;padding:9px 12px;border-radius:14px;
                  background:${meu?'#2C5A00':'var(--sup2)'};color:${meu?'#fff':'var(--ink)'};
                  font-size:13.5px;line-height:1.42;word-break:break-word;white-space:pre-wrap">${_admEsc(m.texto)}</div>
      <div style="font-size:10px;color:var(--ink3);margin:3px 8px 0">${_chatHora(m.criado_em)}${
        podeApagar(m)?` · <span onclick="_net.chatApagar('${m.id}')" style="cursor:pointer;text-decoration:underline">apagar</span>`:''}</div>
    </div>`;
  }).join('');

  const corpo = _chat.carregando ? `<div style="color:var(--ink3);font-size:12.5px;padding:18px 0;text-align:center">Carregando a conversa…</div>`
    : _chat.erro ? `<div style="color:var(--dn);font-size:12.5px;padding:18px 0;text-align:center">Não deu pra ler a conversa.<br><span style="color:var(--ink3);font-size:11px">${_admEsc(_chat.erro)}</span></div>`
    : bolhas || `<div style="color:var(--ink3);font-size:12.5px;padding:22px 0;text-align:center;line-height:1.5">Ninguém falou nada ainda.<br>Começa você.</div>`;

  const ehPartida = _chat.sala === _SALAS.partida;
  /* o campo só existe enquanto a sala está ABERTA — na partida encerrada a
     policy recusaria o insert, e campo que devolve erro não é campo */
  const entrada = _chat.aberta ? `
    <div style="display:flex;gap:8px;align-items:flex-end">
      <textarea id="net-chat-in" rows="1" maxlength="500" placeholder="${ehPartida?'Tô chegando, atrasei 10, leva bola…':'Escreve aí…'}"
        oninput="_net.chatDigitou(this.value);this.style.height='auto';this.style.height=Math.min(96,this.scrollHeight)+'px'"
        style="flex:1;padding:11px 13px;border-radius:14px;border:1px solid var(--linha2);background:var(--bg);color:#fff;
               font:400 13.5px system-ui;resize:none;max-height:96px;line-height:1.4">${_admEsc(_chat.rascunho||'')}</textarea>
      <button onclick="_net.chatEnviar()" style="flex:0 0 auto;padding:11px 16px;border-radius:14px;border:none;background:#2C5A00;color:#fff;font:700 13px system-ui;cursor:pointer">Enviar</button>
    </div>
    <div style="font-size:10.5px;color:var(--ink3);margin-top:7px">Mensagem não se edita — se errou, apaga e manda de novo. ${ehPartida?'Só vocês dois leem, e a conversa fecha com a partida.':'Só quem é da comunidade lê.'}</div>`
  : `<div style="font-size:11.5px;color:var(--ink3);text-align:center;padding:10px 0 2px">A partida encerrou — a conversa fica, mas não recebe mais mensagem.</div>`;

  _sheet('net-chat', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="min-width:0">
        <div style="font:700 17px system-ui">${_chat.sala.titulo}</div>
        <div style="font-size:11.5px;color:var(--ink2)">${ehPartida?'com ':''}${_admEsc(_chat.nome||'')}</div>
      </div>
      <button onclick="_net.fecharChat()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer;flex:0 0 auto">×</button></div>

    <div id="net-chat-lista" style="max-height:46vh;overflow-y:auto;margin:12px 0 10px;padding-right:2px">${corpo}</div>
    ${entrada}`);

  // o fim da conversa é o que interessa: abre no rodapé, não no topo
  const lista = document.getElementById('net-chat-lista');
  if(lista) lista.scrollTop = lista.scrollHeight;
}
async function netDefinirCasa(gid, v){
  const { error } = await sb.from('grupos').update({ local_id: v||null }).eq('id', gid);
  if(error){ alert('Erro ao definir a casa: '+error.message); return; }
  if(window.toast) toast(v ? `📍 Casa da comunidade: <b>${_locNome(v)||''}</b>.` : 'Comunidade sem casa fixa.');
  netVerGrupo(gid);
}

/* Ligar o cinturão. Nasce com quem CRIOU a comunidade (09/08) — se um admin liga,
   vai pro dono, não pra ele. Escrita normal em `comunidades`: a policy grupos_upd
   já limita a dono/gestor, então não precisa de função. */
async function netLigarCinturao(gid){
  const g=(await sb.from('grupos').select('dono_id').eq('id',gid).maybeSingle()).data;
  if(!g) return;
  const { error } = await sb.from('grupos').update({
    cinturao:true, cinturao_dono_id:g.dono_id, cinturao_desde:new Date().toISOString()
  }).eq('id',gid);
  if(error){ alert('Erro ao ligar o cinturão: '+error.message); return; }
  // abre o primeiro reinado no histórico — sem ele o troféu Reinado não apura
  try{ await sb.rpc('cinturao_abrir', { g:gid, dono:g.dono_id }); }catch(e){}
  if(window.toast) toast(g.dono_id===MEU_UID
    ? '🥇 Cinturão ligado — ele nasce com você.'
    : `🥇 Cinturão ligado — nasce com ${_nomeDe(g.dono_id)}, que criou a comunidade.`);
  netVerGrupo(gid);
}

async function netAceitarPedido(gid,uid){
  const { error } = await sb.from('grupo_membros').insert({ grupo_id:gid, player_id:uid, papel:'membro' });
  if(error && !/duplicate/i.test(error.message||'')){ alert('Erro ao aceitar: '+error.message); return; }
  await sb.from('grupo_pedidos').delete().eq('grupo_id',gid).eq('player_id',uid);
  netVerGrupo(gid);
}
async function netRecusarPedido(gid,uid){
  await sb.from('grupo_pedidos').update({estado:'recusado'}).eq('grupo_id',gid).eq('player_id',uid);
  netVerGrupo(gid);
}
async function netMudarPapel(gid,uid,papel){
  const { error } = await sb.from('grupo_membros').update({papel}).eq('grupo_id',gid).eq('player_id',uid);
  if(error){ alert('Erro: '+error.message); return; }
  netVerGrupo(gid);
}
async function netRemoverMembro(gid,uid){
  if(!confirm('Remover '+_nomeDe(uid)+' da comunidade?')) return;
  await sb.from('grupo_membros').delete().eq('grupo_id',gid).eq('player_id',uid);
  netVerGrupo(gid);
}
async function netSairGrupo(gid){
  if(!confirm('Sair da comunidade?')) return;
  await sb.from('grupo_membros').delete().eq('grupo_id',gid).eq('player_id',MEU_UID);
  netMeusQuadros(true).catch(()=>{});   // saiu: some do quadro junto
  netFecharGver(); netAbrirGrupos();
}

// -- link de convite da comunidade (?g=<token>) --
async function netCopiarLinkGrupo(gid){
  const g=(await sb.from('grupos').select('convite').eq('id',gid).maybeSingle()).data;
  if(!g){ alert('Comunidade não encontrada.'); return; }
  const url = location.origin + location.pathname + '?g=' + g.convite;
  try{ await navigator.clipboard.writeText(url); if(window.toast) toast('Link copiado! Quem abrir entra direto na comunidade.'); }
  catch(e){ prompt('Copie o link e mande pro amigo:', url); }
}
async function netRevogarLink(gid){
  if(!confirm('Revogar o link? Quem tiver o link antigo não entra mais.')) return;
  const novo = (crypto.randomUUID && crypto.randomUUID()) || (Date.now()+'-'+Math.random());
  const { error } = await sb.from('grupos').update({convite:novo}).eq('id',gid);
  if(error){ alert('Erro: '+error.message); return; }
  if(window.toast) toast('Link revogado. Copie o novo quando quiser convidar.');
}
async function netEntrarGrupoPorLink(token){
  const g=(await sb.from('grupos').select('id,nome,convite').eq('convite',token).maybeSingle()).data;
  if(!g){ alert('Este convite não vale mais — peça um link novo pro gestor da comunidade.'); return; }
  const ex=await sb.from('grupo_membros').select('player_id').eq('grupo_id',g.id).eq('player_id',MEU_UID);
  if(!(ex.data&&ex.data.length)){
    try{ if(window.netSyncJogador && typeof S!=='undefined') await netSyncJogador(S.jogadores[EU]); }catch(e){}
    const { error } = await sb.from('grupo_membros').insert({ grupo_id:g.id, player_id:MEU_UID, papel:'membro' });
    if(error){ alert('Erro ao entrar: '+error.message); return; }
    await sb.from('grupo_pedidos').delete().eq('grupo_id',g.id).eq('player_id',MEU_UID);
    if(window.toast) toast('Você entrou na comunidade '+g.nome+'!');
    netMeusQuadros(true).catch(()=>{});
  }
  setTimeout(()=>{ try{ netVerGrupo(g.id); }catch(e){} }, 300);
}
window.netAbrirGrupos = netAbrirGrupos;

/* =========================================================================
   TORNEIOS (Bloco 4a) — mata-mata. Criar, inscrever, entrar. A chave (4b) e o
   jogo (4c) vêm depois; cada confronto vira uma partida com torneio_id.
   ========================================================================= */
let _tnew = null;

async function netMeusTorneios(){
  const part = await sb.from('torneio_participantes').select('torneio_id').eq('player_id',MEU_UID);
  const ids = new Set((part.data||[]).map(x=>x.torneio_id));
  let meus=[];
  if(ids.size){ const r=await sb.from('torneios').select('*').in('id',[...ids]).order('created_at',{ascending:false}); meus=r.data||[]; }
  const ab = await sb.from('torneios').select('*').eq('aberto',true).in('status',['inscricoes','em-andamento']).order('created_at',{ascending:false});
  // torneio multi continua recebendo gente nas categorias que ainda não montaram,
  // mesmo com o torneio já 'em-andamento' por causa de outra categoria
  const abertos = (ab.data||[]).filter(t=>{
    if(ids.has(t.id)) return false;
    if(t.status==='inscricoes') return true;
    return t.tipo==='multi' && (t.categorias||[]).some(c=>!c.montada);
  });
  // contagem de inscritos de todos os torneios listados
  const todos=[...meus,...abertos]; const cont={};
  if(todos.length){ const c=await sb.from('torneio_participantes').select('torneio_id').in('torneio_id',todos.map(t=>t.id));
    (c.data||[]).forEach(x=> cont[x.torneio_id]=(cont[x.torneio_id]||0)+1); }
  return { meus, abertos, cont };
}

async function netCriarTorneio(d){
  // garante que existe a linha do jogador (dono) — o torneio tem FK pra players
  try{ if(window.netSyncJogador && typeof S!=='undefined') await netSyncJogador(S.jogadores[EU]); }catch(e){}
  const { data, error } = await sb.from('torneios').insert({
    nome:d.nome, dono_id:MEU_UID, esporte:d.esporte, tamanho:d.tamanho, aberto:!!d.aberto, grupo_id:d.grupo_id||null,
    tipo:d.tipo||'aberto',
    classes: d.tipo==='restrito' ? d.classes : null,
    categorias: d.tipo==='multi' ? d.cats : null,
    // 18/08 (mig 38): `|| null` e não string vazia — o campo `date` do HTML
    // devolve '' quando ninguém escolheu, e '' num `date` do Postgres é erro de
    // sintaxe, não null. Torneio sem data marcada é estado válido.
    comeca_em:  d.comeca_em  || null,
    termina_em: d.termina_em || null,
  }).select().single();
  if(error) throw error;
  await sb.from('torneio_participantes').insert({ torneio_id:data.id, player_id:MEU_UID });
  return data;
}

// minha divisão no esporte do torneio/categoria, direto do banco (fonte da verdade)
async function _minhaDivisao(esporte){
  const me=(await sb.from('players').select('nivel,nivelb').eq('id',MEU_UID).maybeSingle()).data||{};
  const n = esporte==='beach' ? (me.nivelb??1200) : (me.nivel??1200);
  return window.divisaoDe ? divisaoDe(n) : 'D';
}

async function netEntrarTorneio(id, cat){
  const t=(await sb.from('torneios').select('*').eq('id',id).maybeSingle()).data;
  if(!t){ alert('Torneio não encontrado.'); return; }
  // num torneio multi quem fecha é a CATEGORIA, não o torneio: a chave da A pode
  // já ter montado enquanto a B ainda enche
  if(t.tipo!=='multi' && t.status!=='inscricoes'){ alert('As inscrições deste torneio já fecharam.'); return; }
  // restrito: a divisão precisa estar na faixa — fora dela, nem entra
  if(t.tipo==='restrito' && t.classes && t.classes.length){
    const minha = await _minhaDivisao(t.esporte);
    if(!t.classes.includes(minha)){
      alert('Este torneio é restrito às divisões '+t.classes.join(' / ')+'. A sua no '+(t.esporte==='beach'?'beach':'tênis')+' é '+minha+'.');
      return;
    }
  }
  // multi: entra por categoria — sem categoria escolhida, abre o seletor
  if(t.tipo==='multi' && !cat){ netEscolherCategoria(t); return; }
  // lotação: a chave não pode receber mais gente do que cabe nela
  const c = t.tipo==='multi' ? (t.categorias||[]).find(x=>x.id===cat) : null;
  if(t.tipo==='multi' && !c){ alert('Categoria não encontrada.'); return; }
  if(c && c.montada){ alert('A chave desta categoria já montou.'); return; }
  const tam = c ? (c.tamanho||t.tamanho||8) : t.tamanho;
  let qtd = sb.from('torneio_participantes').select('player_id').eq('torneio_id',id);
  if(cat) qtd = qtd.eq('categoria',cat);
  if(((await qtd).data||[]).length >= tam){
    alert(c ? 'A categoria '+c.nome+' já está cheia ('+tam+').' : 'Este torneio já está cheio ('+tam+').');
    return;
  }
  const { error } = await sb.from('torneio_participantes').insert({ torneio_id:id, player_id:MEU_UID, categoria:cat||null });
  if(error){ alert('Erro ao entrar: '+error.message); return; }
  if(window.toast) toast('Você entrou no torneio.');
  const el=document.getElementById('net-tcat'); if(el) el.remove();
  netAbrirTorneios();
}

// -- UI: escolher categoria num torneio multi (modo Ace Open) --
async function netEscolherCategoria(t){
  const cats=t.categorias||[];
  // elegibilidade por categoria: sem classes = todas as divisões
  const divT=await _minhaDivisao('tenis'), divB=await _minhaDivisao('beach');
  const insc=(await sb.from('torneio_participantes').select('categoria').eq('torneio_id',t.id)).data||[];
  const cont={}; insc.forEach(p=>{ if(p.categoria) cont[p.categoria]=(cont[p.categoria]||0)+1; });
  const rows=cats.map(c=>{
    const minha = c.esporte==='beach'?divB:divT;
    const tam = c.tamanho||t.tamanho||8, n = cont[c.id]||0;
    const naFaixa = !(c.classes&&c.classes.length) || c.classes.includes(minha);
    const ok = naFaixa && !c.montada && n<tam;
    const motivo = !naFaixa ? ' · fora da sua classe ('+minha+')'
                 : c.montada ? ' · chave já montada'
                 : n>=tam    ? ' · cheia' : '';
    const sub = (c.esporte==='beach'?'Beach':'Tênis')+' · '+((c.classes&&c.classes.length)?'divisões '+c.classes.join('/'):'todas as divisões')+' · '+n+'/'+tam;
    return `<div style="display:flex;align-items:center;gap:11px;padding:12px;border:1px solid var(--linha);border-radius:12px;margin-top:8px;opacity:${ok?1:.45}">
      <div style="flex:1;min-width:0"><b>${c.nome}</b><div style="font-size:11px;color:var(--ink2)">${sub}${motivo}</div></div>
      ${ok?`<button onclick="_net.entrarTorneio('${t.id}','${c.id}')" style="padding:7px 12px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Entrar</button>`:''}
    </div>`;
  }).join('');
  _sheet('net-tcat', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">${t.nome} — categorias</div>
      <button onclick="document.getElementById('net-tcat').remove()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:6px 0 4px">Escolha a sua categoria. Cada uma tem chave e campeão próprios.</div>
    ${rows||'<p style="color:var(--ink2);font-size:13px">Este torneio ainda não tem categorias.</p>'}`);
}
async function netSairTorneio(id){
  await sb.from('torneio_participantes').delete().eq('torneio_id',id).eq('player_id',MEU_UID);
  netAbrirTorneios();
}

// -- UI: lista de torneios --
/* 18/08: a fase do torneio em português. O `status` do banco tem três valores
   e eles vazavam crus pra tela ("em-andamento" com hífen, "concluido" sem
   acento) — vocabulário de coluna não é vocabulário de gente.

   ⚠️ A DATA do torneio não entra aqui porque ela NÃO EXISTE: `torneios` tem
   `created_at` e mais nada de tempo (mig 4, mais as colunas de 5, 8 e 10).
   Usar `created_at` como data do torneio seria mentir — "criado em" não é
   "acontece em". Separar futuro de passado depende de uma coluna nova. */
const _FASES = {
  'inscricoes':   ['Inscrições', 'var(--lime)'],
  'em-andamento': ['Em andamento', 'var(--gold)'],
  'concluido':    ['Encerrado', 'var(--ink3)'],
};

/* 18/08 (mig 38): a data no card.
   `comeca_em` vem como 'AAAA-MM-DD' e é lida como DIA, não como instante. Um
   `new Date('2026-08-20')` seria interpretado como meia-noite UTC e, no fuso do
   Brasil, viraria 19/08 21h — o torneio apareceria um dia antes pra todo mundo.
   Por isso a data é partida na mão e montada com `new Date(a, m-1, d)`, que é
   local. É o mesmo motivo pelo qual a coluna é `date` e não `timestamptz`. */
function _dataLocal(iso){
  if(!iso) return null;
  const p = String(iso).slice(0,10).split('-').map(Number);
  return (p.length===3 && p.every(Number.isFinite)) ? new Date(p[0], p[1]-1, p[2]) : null;
}
const _DIA = ['dom','seg','ter','qua','qui','sex','sáb'];
function _torneioQuando(t){
  const ini = _dataLocal(t.comeca_em), fim = _dataLocal(t.termina_em);
  if(!ini && !fim) return '';
  const p = (n)=>String(n).padStart(2,'0');
  const curto = (d)=>`${p(d.getDate())}/${p(d.getMonth()+1)}`;
  let txt;
  if(ini && fim && +ini !== +fim)      txt = `${curto(ini)} a ${curto(fim)}`;
  else if(ini)                          txt = `${_DIA[ini.getDay()]} ${curto(ini)}`;
  else                                  txt = `até ${curto(fim)}`;
  /* "hoje" e "amanhã" ganham destaque porque são a única informação da lista
     que caduca em horas. O resto fica em cinza igual ao resto do card. */
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const dias = ini ? Math.round((ini - hoje)/864e5) : null;
  const realce = dias===0 ? ['var(--lime)','hoje'] : dias===1 ? ['var(--gold)','amanhã'] : null;
  return `<div style="font-size:11px;color:${realce?realce[0]:'var(--ink2)'};margin-top:3px">🗓 ${realce?realce[1]+' · ':''}${txt}</div>`;
}
function _faseSelo(t){
  const f = _FASES[t.status] || _FASES['inscricoes'];
  return `<span style="flex:0 0 auto;padding:2px 8px;border-radius:99px;background:var(--sup2);`
       + `color:${f[1]};font:700 9.5px system-ui;letter-spacing:.06em;text-transform:uppercase">${f[0]}</span>`;
}

async function netAbrirTorneios(){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const {meus,abertos,cont}=await netMeusTorneios();
  const card=(t,entrar)=>{
    const n=cont[t.id]||0; const esp=t.tipo==='multi'?((t.categorias||[]).length+' categorias'):(t.esporte==='beach'?'Beach':'Tênis');
    const regra=t.tipo==='restrito'&&t.classes?' · div. '+t.classes.join('/'):'';
    return `<div class="tsheet-item" onclick="_net.verTorneio('${t.id}')" style="display:flex;align-items:center;gap:11px;padding:13px;border:1px solid var(--linha);border-radius:12px;margin-top:8px;cursor:pointer">
      <div style="width:34px;height:34px;border-radius:9px;background:var(--sup2);display:flex;align-items:center;justify-content:center;font-size:16px;flex:0 0 34px">🏆</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:7px"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.nome}</b>${_faseSelo(t)}</div>
        ${_torneioQuando(t)}
        <div style="font-size:11px;color:var(--ink2);margin-top:2px">${esp} · mata-mata · ${n}${t.tipo==='multi'?'':'/'+t.tamanho} inscritos${regra} · ${t.aberto?'aberto':'fechado'}</div></div>
      ${entrar?`<button onclick="event.stopPropagation();_net.entrarTorneio('${t.id}')" style="padding:7px 12px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Entrar</button>`:'<span style="color:var(--ink2)">›</span>'}
    </div>`;
  };
  /* 18/08: "Seus torneios" era uma pilha só, do inscrição ao concluído, e a fase
     ia no fim da linha densa com a palavra crua do banco ("em-andamento"). Agora
     separa por fase e o selo diz em português. A ordem é a da urgência: o que
     está rolando agora vem primeiro, o que já acabou vai pro fim. */
  /* 18/08 (mig 38): dentro de cada fase, a data manda — quem tem dia marcado
     vem primeiro, do mais próximo pro mais distante, e os sem data caem no fim
     na ordem de criação (que era a ordem única de antes). A leitura de quem
     abre a lista é "quando eu jogo", não "quando alguém criou". */
  const porFase = (lista, st)=> lista
    .filter(t=> (t.status||'inscricoes')===st)
    .slice().sort((a,b)=>{
      if(a.comeca_em && b.comeca_em) return a.comeca_em < b.comeca_em ? -1 : a.comeca_em > b.comeca_em ? 1 : 0;
      if(a.comeca_em) return -1;
      if(b.comeca_em) return 1;
      return 0;                       // os dois sem data: mantém a ordem que veio
    });
  const grupo = (rot, lista, entrar)=> lista.length
    ? `<div style="font:700 12px system-ui;color:var(--ink2);margin-top:16px;text-transform:uppercase;letter-spacing:.08em">${rot}</div>`
      + lista.map(t=>card(t,entrar)).join('')
    : '';
  const meusH = meus.length
    ? grupo('Em andamento', porFase(meus,'em-andamento'), false)
      + grupo('Inscrições abertas', porFase(meus,'inscricoes'), false)
      + grupo('Encerrados', porFase(meus,'concluido'), false)
    : `<p style="color:var(--ink2);font-size:13px;margin-top:8px">Você não está em nenhum torneio ainda.</p>`;
  const abH = grupo('Torneios abertos', abertos, true);
  _sheet('net-torneios', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Torneios</div>
      <button onclick="_net.fecharTorneios()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    ${_quemSou()}
    <button onclick="_net.criarTorneio()" style="width:100%;padding:13px;border-radius:12px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:700 14px system-ui;cursor:pointer;margin-top:10px">+ Criar torneio</button>
    <div style="font:700 12px system-ui;color:var(--ink2);margin-top:16px;text-transform:uppercase;letter-spacing:.08em">Seus torneios</div>
    ${meusH}${abH}`);
}
function netFecharTorneios(){ const el=document.getElementById('net-torneios'); if(el) el.remove(); }

// -- UI: criar torneio --
function netCriarTorneioUI(){
  _tnew = _tnew || { nome:'', esporte:(typeof S!=='undefined'&&S.esporte)||'tenis', tamanho:8, aberto:false, tipo:'aberto', classes:[], cats:[] };
  const seg=(campo,ops)=>ops.map(([v,n])=>`<button onclick="_net.tset('${campo}','${v}')" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--linha2);font:600 13px system-ui;cursor:pointer;background:${_tnew[campo]==v?'#2C5A00':'var(--sup2)'};color:#fff">${n}</button>`).join('');
  const chip=(d,on,click)=>`<button onclick="${click}" style="flex:1;padding:9px;border-radius:9px;border:1px solid var(--linha2);font:700 13px system-ui;cursor:pointer;background:${on?'#2C5A00':'var(--sup2)'};color:#fff">${d}</button>`;
  // bloco extra conforme o tipo escolhido
  let extra='';
  if(_tnew.tipo==='restrito'){
    extra = `<div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Divisões que jogam</div>
      <div style="display:flex;gap:8px">${['A','B','C','D'].map(d=>chip(d,_tnew.classes.includes(d),`_net.tclasse('${d}')`)).join('')}</div>`;
  }
  if(_tnew.tipo==='multi'){
    const catRow=(c,i)=>`<div style="border:1px solid var(--linha);border-radius:12px;padding:11px;margin-top:8px">
      <div style="display:flex;gap:8px;align-items:center">
        <input value="${(c.nome||'').replace(/"/g,'&quot;')}" oninput="_net.tcatset(${i},'nome',this.value)" placeholder="Nome da categoria (ex.: C masculino)" style="flex:1;padding:10px;border-radius:9px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui" autocomplete="off"/>
        <button onclick="_net.tcatdel(${i})" style="background:none;border:none;color:var(--ink2);font-size:19px;cursor:pointer">×</button></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        ${chip('Tênis',c.esporte!=='beach',`_net.tcatset(${i},'esporte','tenis')`)}${chip('Beach',c.esporte==='beach',`_net.tcatset(${i},'esporte','beach')`)}</div>
      <div style="display:flex;gap:8px;margin-top:8px">${['A','B','C','D'].map(d=>chip(d,(c.classes||[]).includes(d),`_net.tcatclasse(${i},'${d}')`)).join('')}</div>
      <div style="font-size:10px;color:var(--ink3);margin-top:5px">Nenhuma classe marcada = todas jogam nesta categoria.</div>
      <div style="font-size:11px;color:var(--ink2);margin:9px 0 5px">Tamanho da chave</div>
      <div style="display:flex;gap:8px">${[4,8,16].map(n=>chip(n,(c.tamanho||8)===n,`_net.tcatset(${i},'tamanho','${n}')`)).join('')}</div>
    </div>`;
    extra = `<div style="font-size:12px;color:var(--ink2);margin:14px 0 2px">Categorias (cada uma tem chave e campeão próprios)</div>
      ${_tnew.cats.map(catRow).join('')}
      <button onclick="_net.tcatadd()" style="width:100%;padding:11px;border-radius:11px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:8px">+ Adicionar categoria</button>`;
  }
  _sheet('net-tnew', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">${_tnew.id?'Editar regras':'Criar torneio'}</div>
      <button onclick="_net.fecharTnew()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <input id="tn-nome" value="${(_tnew.nome||'').replace(/"/g,'&quot;')}" oninput="_net.tset('nome',this.value)" placeholder="Nome do torneio" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;margin-top:12px" autocomplete="off"/>
    ${_tnew.tipo!=='multi'?`<div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Esporte</div><div style="display:flex;gap:8px">${seg('esporte',[['tenis','Tênis'],['beach','Beach']])}</div>`:''}
    ${_tnew.tipo!=='multi'?`<div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Tamanho da chave</div><div style="display:flex;gap:8px">${seg('tamanho',[[4,'4'],[8,'8'],[16,'16']])}</div>`:''}
    <div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Quem joga</div><div style="display:flex;gap:8px">${seg('tipo',[['aberto','Todas as divisões'],['restrito','Só algumas'],['multi','Categorias']])}</div>
    ${extra}
    <div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Quem entra</div><div style="display:flex;gap:8px">${seg('aberto',[[false,'Fechado (convite)'],[true,'Aberto']])}</div>

    <!-- 18/08 (mig 38): a data. As duas OPCIONAIS de propósito — torneio da
         comunidade nasce como "vou fazer um torneio" antes de ter dia, e
         obrigar aqui empurraria todo mundo a chutar uma data pra conseguir
         criar. Chute vira dado errado que a lista trata como verdade. -->
    <div style="font-size:12px;color:var(--ink2);margin:16px 0 6px">Quando acontece <span style="color:var(--ink3)">(opcional)</span></div>
    <div style="display:flex;gap:8px">
      <div style="flex:1">
        <div style="font-size:10.5px;color:var(--ink3);margin-bottom:4px">Começa</div>
        <input type="date" value="${_tnew.comeca_em||''}" onchange="_net.tset('comeca_em',this.value)"
          style="width:100%;padding:11px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui;color-scheme:dark"/>
      </div>
      <div style="flex:1">
        <div style="font-size:10.5px;color:var(--ink3);margin-bottom:4px">Termina</div>
        <input type="date" value="${_tnew.termina_em||''}" min="${_tnew.comeca_em||''}" onchange="_net.tset('termina_em',this.value)"
          style="width:100%;padding:11px;border-radius:11px;border:1px solid ${(_tnew.comeca_em&&_tnew.termina_em&&_tnew.termina_em<_tnew.comeca_em)?'var(--dn)':'var(--linha2)'};background:var(--bg);color:#fff;font:600 13px system-ui;color-scheme:dark"/>
      </div>
    </div>
    ${(_tnew.comeca_em&&_tnew.termina_em&&_tnew.termina_em<_tnew.comeca_em)
      ? '<div style="font-size:11px;color:var(--dn);margin-top:6px">O fim está antes do começo — o banco vai recusar.</div>'
      : '<div style="font-size:11px;color:var(--ink3);margin-top:6px">Só o dia. A hora de cada partida é combinada dentro do torneio.</div>'}
    ${_tnew.id?'<div style="font-size:11px;color:var(--ink3);margin-top:10px">As regras podem mudar enquanto as inscrições estão abertas. Quando a chave montar, congelam.</div>':''}
    <button onclick="_net.tcriar()" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:18px">${_tnew.id?'Salvar regras':'Criar torneio'}</button>`);
  const el=document.getElementById('tn-nome'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); }
}
function _tset(campo,v){ if(v==='true')v=true; if(v==='false')v=false; if(campo==='tamanho')v=+v; _tnew[campo]=v; if(campo!=='nome') netCriarTorneioUI(); }
function _tclasse(d){ const i=_tnew.classes.indexOf(d); i>=0?_tnew.classes.splice(i,1):_tnew.classes.push(d); netCriarTorneioUI(); }
function _tcatadd(){ _tnew.cats.push({ id:'c'+Date.now().toString(36), nome:'', esporte:_tnew.esporte, classes:[], tamanho:8 }); netCriarTorneioUI(); }
function _tcatdel(i){ _tnew.cats.splice(i,1); netCriarTorneioUI(); }
function _tcatset(i,campo,v){ if(campo==='tamanho')v=+v; _tnew.cats[i][campo]=v; if(campo!=='nome') netCriarTorneioUI(); }
function _tcatclasse(i,d){ const c=_tnew.cats[i]; c.classes=c.classes||[]; const k=c.classes.indexOf(d); k>=0?c.classes.splice(k,1):c.classes.push(d); netCriarTorneioUI(); }
async function _tcriar(){
  if(!_tnew.nome || !_tnew.nome.trim()){ alert('Dá um nome pro torneio.'); return; }
  if(_tnew.tipo==='restrito' && !_tnew.classes.length){ alert('Marque pelo menos uma classe.'); return; }
  if(_tnew.tipo==='multi'){
    _tnew.cats=_tnew.cats.filter(c=>c.nome&&c.nome.trim());
    if(!_tnew.cats.length){ alert('Adicione pelo menos uma categoria com nome.'); return; }
  }
  try{
    if(_tnew.id){
      // edição de regras — só existe enquanto status='inscricoes' (o botão só aparece lá)
      const { error } = await sb.from('torneios').update({
        nome:_tnew.nome, esporte:_tnew.esporte, tamanho:_tnew.tamanho, aberto:!!_tnew.aberto,
        tipo:_tnew.tipo||'aberto',
        classes: _tnew.tipo==='restrito' ? _tnew.classes : null,
        categorias: _tnew.tipo==='multi' ? _tnew.cats : null,
        comeca_em:  _tnew.comeca_em  || null,
        termina_em: _tnew.termina_em || null,
      }).eq('id',_tnew.id).eq('status','inscricoes');
      if(error) throw error;
      const id=_tnew.id; _tnew=null;
      const el=document.getElementById('net-tnew'); if(el) el.remove();
      if(window.toast) toast('Regras salvas.');
      netVerTorneio(id);
      return;
    }
    const t=await netCriarTorneio(_tnew); _tnew=null;
    const el=document.getElementById('net-tnew'); if(el) el.remove();
    if(window.toast) toast('Torneio criado! Chame a galera pra encher a chave.');
    netAbrirTorneios();
  }catch(e){ alert('Erro ao salvar: '+(e.message||e)); }
}
function netFecharTnew(){ _tnew=null; const el=document.getElementById('net-tnew'); if(el) el.remove(); }

// -- editar regras (dono, só em inscrições): reusa a sheet de criar --
async function netEditarTorneio(id){
  const t=(await sb.from('torneios').select('*').eq('id',id).maybeSingle()).data;
  if(!t){ alert('Torneio não encontrado.'); return; }
  if(t.status!=='inscricoes'){ alert('A chave já montou — as regras estão congeladas.'); return; }
  _tnew = { id:t.id, nome:t.nome, esporte:t.esporte, tamanho:t.tamanho, aberto:!!t.aberto,
    tipo:t.tipo||'aberto', classes:t.classes||[], cats:t.categorias||[],
    // 18/08: sem trazer as datas de volta, abrir "editar regras" e salvar
    // APAGARIA a data já marcada — o update manda `|| null` e o campo vazio
    // venceria. Formulário de edição que nasce sem o valor atual não é
    // formulário, é sorteio.
    comeca_em:t.comeca_em||'', termina_em:t.termina_em||'' };
  netFecharTver(); netCriarTorneioUI();
}

/* ---- 4b: chaveamento ---------------------------------------------------- */
// pares da rodada 1 na ordem clássica de bracket (cabeças separados)
function _ordemChave(n){
  return n===4 ? [[1,4],[3,2]]
       : n===8 ? [[1,8],[4,5],[3,6],[2,7]]
       : [[1,16],[8,9],[5,12],[4,13],[3,14],[6,11],[7,10],[2,15]];
}
const _winDe = m => (m && m.status==='confirmada') ? (m.venceu_criador ? m.criador_id : m.adversario_id) : null;

// dono monta a chave: seed por Nível (banco = autoridade) e congela as regras.
// Em torneio multi, monta UMA categoria por vez — elas enchem em ritmos
// diferentes e travar todas até a última encher seguraria o torneio inteiro.
// As regras congelam globalmente na PRIMEIRA montagem (status sai de 'inscricoes'),
// pra não abrir brecha de editar categoria que já está em jogo.
async function netMontarChave(id, catId){
  const t=(await sb.from('torneios').select('*').eq('id',id).maybeSingle()).data;
  if(!t || t.dono_id!==MEU_UID) return;
  const multi = t.tipo==='multi';
  if(!multi && t.status!=='inscricoes') return;
  const cats = t.categorias||[];
  const c = multi ? cats.find(x=>x.id===catId) : null;
  if(multi && !c){ alert('Categoria não encontrada.'); return; }
  if(c && c.montada){ alert('A chave desta categoria já montou.'); return; }
  const tam = c ? (c.tamanho||t.tamanho||8) : t.tamanho;
  const esporte = c ? (c.esporte||'tenis') : t.esporte;
  const todos=(await sb.from('torneio_participantes').select('player_id,categoria').eq('torneio_id',id)).data||[];
  const ps = multi ? todos.filter(p=>p.categoria===catId) : todos;
  if(ps.length<tam){ alert('A chave ainda não encheu ('+ps.length+'/'+tam+').'); return; }
  if(!confirm(multi
      ? 'Montar a chave de '+c.nome+'? As inscrições desta categoria fecham e as regras do torneio congelam.'
      : 'Montar a chave? As inscrições fecham e as regras congelam.')) return;
  const ids=ps.map(p=>p.player_id);
  const nv=(await sb.from('players').select('id,nivel,nivelb').in('id',ids)).data||[];
  const n={}; nv.forEach(p=>n[p.id]= esporte==='beach'?(p.nivelb??1200):(p.nivel??1200));
  ids.sort((a,b)=>(n[b]||0)-(n[a]||0));
  for(let i=0;i<ids.length;i++){
    await sb.from('torneio_participantes').update({seed:i+1}).eq('torneio_id',id).eq('player_id',ids[i]);
  }
  const patch = multi
    ? { status:'em-andamento', categorias: cats.map(x=> x.id===catId ? Object.assign({},x,{montada:true}) : x) }
    : { status:'em-andamento' };
  const { error } = await sb.from('torneios').update(patch).eq('id',id);
  if(error){ alert('Erro ao montar: '+error.message); return; }
  if(window.toast) toast(multi ? 'Chave de '+c.nome+' montada! Maior Nível é o cabeça 1.' : 'Chave montada! Maior Nível é o cabeça 1.');
  netVerTorneio(id);
}

// lançar placar de um confronto da chave — a partida nasce pronta (status
// 'aceito') na primeira vez e reusa o fluxo placar→confirma de sempre
async function netTorneioPlacar(tid,rodada,pos,advUid,catId){
  let q=sb.from('matches').select('*').eq('torneio_id',tid).eq('torneio_rodada',rodada).eq('torneio_pos',pos);
  q = catId ? q.eq('torneio_categoria',catId) : q.is('torneio_categoria',null);
  let m=(await q.maybeSingle()).data;
  if(!m){
    const t=(await sb.from('torneios').select('esporte,categorias').eq('id',tid).maybeSingle()).data||{};
    // no multi o esporte é o da CATEGORIA, não o do torneio
    const c = catId ? (t.categorias||[]).find(x=>x.id===catId) : null;
    const ins=await sb.from('matches').insert({
      criador_id:MEU_UID, adversario_id:advUid, esporte:(c&&c.esporte)||t.esporte||'tenis',
      formato:'md3', dupla:false, status:'aceito',
      torneio_id:tid, torneio_rodada:rodada, torneio_pos:pos, torneio_categoria:catId||null,
    }).select().single();
    if(ins.error){ alert('Erro: '+ins.error.message); return; }
    m=ins.data;
  }
  if(m.status==='pendente'){ alert('Placar já lançado — falta o adversário confirmar (caixa de partidas).'); return; }
  if(m.status==='confirmada'){ netVerTorneio(tid); return; }
  const j=S.jogadores[_chaveLocal(advUid)]||{};
  _on={ step:'placar', matchId:m.id, souCriador:m.criador_id===MEU_UID,
        ctx:_ctxDoTorneio(await _torneioDe(tid)), fmt:m.formato, dupla:!!m.dupla,
        adv:{id:advUid, nome:j.nome||_nomeDe(advUid), nivel:j.nivel, nivelb:j.nivelB}, sets:null, placarTxt:'' };
  netFecharTver(); netRenderOnline();
}

// override do organizador (migração 9): o dono lança o placar de um confronto
// ALHEIO e ele vale na hora — rede de segurança pra chave não travar no evento.
// Quando o dono é um dos jogadores, vale o fluxo normal (a confirmação do
// adversário é o que impede o dono de trapacear a si mesmo).
async function netTorneioPlacarOrg(tid,rodada,pos,aUid,bUid,catId){
  let q=sb.from('matches').select('*').eq('torneio_id',tid).eq('torneio_rodada',rodada).eq('torneio_pos',pos);
  q = catId ? q.eq('torneio_categoria',catId) : q.is('torneio_categoria',null);
  const m=(await q.maybeSingle()).data;
  if(m && m.status==='confirmada'){ netVerTorneio(tid); return; }
  // se a partida já existe, A/B viram criador/adversário DELA — os sets são
  // gravados na perspectiva do criador e inverter aqui inverteria o vencedor
  if(m){ aUid=m.criador_id; bUid=m.adversario_id; }
  const t=(await sb.from('torneios').select('esporte,categorias').eq('id',tid).maybeSingle()).data||{};
  const c=catId?(t.categorias||[]).find(x=>x.id===catId):null;
  _on={ step:'placar-org', tid, rodada, pos, catId:catId||null, matchId:m?m.id:null,
        esporte:(c&&c.esporte)||t.esporte||'tenis',
        fmt:(m&&m.formato)||'md3', dupla:!!(m&&m.dupla),
        a:{id:aUid,nome:_nomeDe(aUid)}, b:{id:bUid,nome:_nomeDe(bUid)},
        // placar pendente já digitado entra pré-carregado: o organizador confere
        // (ou corrige) em vez de digitar do zero
        placarTxt:(m&&m.placar)||'', sets:(m&&m.sets)||netParsePlacar((m&&m.placar)||'') };
  netFecharTver(); netRenderOnline();
}

async function _onEnviarOrg(){
  const o=_on; const sets=o&&o.sets; if(!sets) return;
  let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
  if(g===p){ alert('Placar empatado — confira os sets.'); return; }
  const venceuA = g>p;   // sets na perspectiva de A (o criador da partida)
  try{
    let mid=o.matchId;
    if(!mid){
      const ins=await sb.from('matches').insert({
        criador_id:o.a.id, adversario_id:o.b.id, esporte:o.esporte,
        formato:'md3', dupla:false, status:'aceito',
        torneio_id:o.tid, torneio_rodada:o.rodada, torneio_pos:o.pos, torneio_categoria:o.catId||null,
      }).select().single();
      if(ins.error) throw ins.error;
      mid=ins.data.id;
    }
    // deltas dos dois, direto do banco — a MESMA conta da confirmação normal;
    // cada jogador aplica o seu quando abrir o app (netAplicarConfirmadas)
    const { data:ps } = await sb.from('players').select('id,nivel,nivelb,calibrando,cal').in('id',[o.a.id,o.b.id]);
    const byId={}; (ps||[]).forEach(x=>byId[x.id]=x);
    const nv=uid=> o.esporte==='beach' ? (byId[uid]?.nivelb??1200) : (byId[uid]?.nivel??1200);
    const ctx=_ctxDoTorneio(await _torneioDe(o.tid));
    const dC=calcular(nv(o.a.id), nv(o.b.id),  venceuA, ctx, o.fmt, !!o.dupla, byId[o.a.id]?.calibrando, byId[o.a.id]?.cal);
    const dA=calcular(nv(o.b.id), nv(o.a.id), !venceuA, ctx, o.fmt, !!o.dupla, byId[o.b.id]?.calibrando, byId[o.b.id]?.cal);
    const { error } = await sb.from('matches').update({
      sets, placar:sets.map(([x,y])=>`${x}-${y}`).join(' '), venceu_criador:venceuA,
      placar_por:MEU_UID, status:'confirmada', delta_criador:dC, delta_adversario:dA,
      confirmed_at:new Date().toISOString(),
    }).eq('id',mid);
    if(error) throw error;
    netFecharOnline();
    if(window.toast) toast('Placar do organizador valeu — o Nível mexe nos dois quando abrirem o app.');
    await netCreditarPontos(mid);
    /* O `id` da partida virou obrigatório (migração 17). RESSALVA: aqui quem
       lança é o ORGANIZADOR, que não é nenhum dos dois jogadores — o banco
       exige `auth.uid() in (criador, adversario)` e devolve false. O cinturão
       NÃO passa em placar lançado pelo organizador. Já era assim antes da 17
       (a versão velha exigia o mesmo); fica anotado como decisão pendente, não
       como regressão. */
    await _cinturaoTentarPassar({ id:mid, esporte:o.esporte, criador_id:o.a.id, adversario_id:o.b.id, venceu_criador:venceuA });
    netVerTorneio(o.tid);
  }catch(e){ alert('Não deu: '+(e.message||e)); }
}

/* ---- 4d: meus campeonatos ---------------------------------------------- */
// troféu de campeão é DERIVADO do banco (torneios concluídos), não tabela nova:
// reusar o objeto existente ganha persistência e RLS de graça, e a sala nunca
// fica inconsistente com a chave. No multi, cada categoria vencida é um troféu.
async function netMeusCampeonatos(){
  if(!MEU_UID) return [];
  const ts=(await sb.from('torneios').select('nome,esporte,tamanho,tipo,categorias,campeao_id,campeoes,created_at').eq('status','concluido')).data||[];
  const out=[];
  ts.forEach(t=>{
    if(t.tipo==='multi'){
      (t.categorias||[]).forEach(c=>{
        if((t.campeoes||{})[c.id]===MEU_UID)
          out.push({ nome:t.nome, cat:c.nome, esporte:c.esporte||'tenis', chave:c.tamanho||t.tamanho||8, quando:t.created_at });
      });
    } else if(t.campeao_id===MEU_UID){
      out.push({ nome:t.nome, cat:null, esporte:t.esporte||'tenis', chave:t.tamanho, quando:t.created_at });
    }
  });
  out.sort((a,b)=> (b.quando||'').localeCompare(a.quando||''));
  return out;
}

// -- UI: detalhe do torneio (participantes) --
async function netVerTorneio(id){
  const t=(await sb.from('torneios').select('*').eq('id',id).single()).data;
  // `categoria` precisa vir no select — sem ela o agrupamento do multi filtra por
  // undefined e toda categoria aparece vazia
  const ps=(await sb.from('torneio_participantes').select('player_id,seed,categoria').eq('torneio_id',id)).data||[];
  // garante nomes no elenco
  if(window.aplicarJogadoresReais && ps.some(p=>!S.jogadores[_chaveLocal(p.player_id)])){ try{ window.aplicarJogadoresReais(await netAdversarios()); }catch(e){} }
  const souParticipante=ps.some(p=>p.player_id===MEU_UID);
  const cheio = ps.length>=t.tamanho;
  const linha=p=>`<div style="display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--sup2)">
      ${_discoUid(p.player_id, 28)}
      <div style="flex:1"><b>${_nomeDe(p.player_id)}</b> <span style="color:var(--ink3);font-size:11px">${netId(p.player_id)}</span></div>
      ${p.player_id===t.dono_id?'<span style="color:var(--gold);font-size:11px">dono</span>':''}
    </div>`;
  const cats = t.tipo==='multi' ? (t.categorias||[]) : [];
  const _tamCat = c => c.tamanho||t.tamanho||8;
  let lista;
  if(t.tipo==='multi'){
    // agrupado por categoria, cada uma com seu tamanho, seu estado e seu botão de montar
    lista=cats.map(c=>{
      const dentro=ps.filter(p=>p.categoria===c.id), tam=_tamCat(c);
      const podeMontar = t.dono_id===MEU_UID && !c.montada && dentro.length>=tam;
      return `<div style="font:700 12px system-ui;color:var(--ink2);margin-top:14px;text-transform:uppercase;letter-spacing:.08em">${c.nome} · ${dentro.length}/${tam}${c.montada?' · em jogo':''}</div>`
        + (dentro.map(linha).join('')||'<p style="color:var(--ink3);font-size:12px;margin:6px 0">Ninguém ainda.</p>')
        + (podeMontar?`<button onclick="_net.montarChave('${id}','${c.id}')" style="width:100%;padding:11px;border-radius:11px;border:none;background:var(--gold-bg);color:#fff;font:700 13px system-ui;cursor:pointer;margin-top:8px">⚔️ Montar a chave de ${c.nome}</button>`:'');
    }).join('');
  } else {
    lista=ps.map(linha).join('');
  }
  // -- chave (status em-andamento/concluido): computada dos seeds + partidas --
  let chaveH='';
  const jogando = t.tipo==='multi' ? cats.some(c=>c.montada) : t.status!=='inscricoes';
  if(jogando){
    const mts=(await sb.from('matches').select('*').eq('torneio_id',id)).data||[];
    // a categoria entra na chave da partida — sem ela a semi 1 da A e a semi 1 da B colidem
    const mAt={}; mts.forEach(m=>{ mAt[(m.torneio_categoria||'')+'|'+m.torneio_rodada+'|'+m.torneio_pos]=m; });
    const nCurto=uid=>uid?_nomeDe(uid).split(' ')[0]:'—';
    // monta a estrutura derivada (seeds + partidas) de UMA chave
    const montar=(lista,tam,catId)=>{
      const seedUid={}; lista.forEach(p=>{ if(p.seed) seedUid[p.seed]=p.player_id; });
      const rounds=Math.round(Math.log2(tam));
      const confs=[];
      for(let r=1;r<=rounds;r++){
        confs[r]=[];
        for(let i=0;i<tam/Math.pow(2,r);i++){
          let a,b;
          if(r===1){ const par=_ordemChave(tam)[i]; a=seedUid[par[0]]; b=seedUid[par[1]]; }
          else { a=_winDe(confs[r-1][2*i].m); b=_winDe(confs[r-1][2*i+1].m); }
          confs[r][i]={a,b,m:mAt[(catId||'')+'|'+r+'|'+i]};
        }
      }
      return { confs, rounds, campeao:_winDe(confs[rounds][0].m) };
    };
    const pintar=(k,catId)=>{
      const rotulo=r=> r===k.rounds?'Final' : r===k.rounds-1?'Semis' : r===k.rounds-2?'Quartas' : 'Oitavas';
      const confHTML=(c,r,i)=>{
        const w=_winDe(c.m);
        const lin=uid=>`<div style="padding:5px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${w&&uid===w?'color:var(--up);font-weight:700':uid?'':'color:var(--linha2)'}">${nCurto(uid)}</div>`;
        let acaoC='';
        if(c.a&&c.b&&!w){
          const souJog = MEU_UID===c.a||MEU_UID===c.b;
          if(c.m&&c.m.status==='pendente') acaoC=`<div style="font-size:10px;color:var(--gold);padding:0 9px 6px">placar lançado · falta confirmar</div>`;
          else if(souJog){
            const adv=MEU_UID===c.a?c.b:c.a;
            acaoC=`<button onclick="_net.torneioPlacar('${id}',${r},${i},'${adv}'${catId?",'"+catId+"'":''})" style="margin:2px 9px 8px;padding:6px 10px;border-radius:8px;border:none;background:#2C5A00;color:#fff;font:600 11px system-ui;cursor:pointer">Lançar placar</button>`;
          }
          // rede de segurança: o dono lança por cima em confronto ALHEIO (vale na
          // hora) — cobre jogador sem celular, sumido ou placar pendente travado
          if(!souJog && t.dono_id===MEU_UID){
            acaoC+=`<button onclick="_net.torneioPlacarOrg('${id}',${r},${i},'${c.a}','${c.b}'${catId?",'"+catId+"'":''})" style="margin:2px 9px 8px;padding:6px 10px;border-radius:8px;border:1px solid var(--gold-bg);background:var(--sup2);color:var(--gold);font:600 11px system-ui;cursor:pointer">Placar (org.)</button>`;
          }
        }
        return `<div style="border:1px solid var(--linha);border-radius:10px;background:var(--sup);margin-top:8px;min-width:132px;font-size:13px">
          ${lin(c.a)}<div style="border-top:1px solid var(--sup2)"></div>${lin(c.b)}
          ${c.m&&c.m.placar?`<div style="font-size:10px;color:var(--ink2);padding:0 9px 5px">${c.m.placar}</div>`:''}${acaoC}</div>`;
      };
      return (k.campeao?`<div style="text-align:center;padding:11px;border:1px solid var(--gold-bg);border-radius:12px;background:var(--sup2);margin-top:10px">🏆 <b>Campeão: ${_nomeDe(k.campeao)}</b></div>`:'')
        + `<div style="display:flex;gap:10px;overflow-x:auto;padding:10px 0 4px">`
        + k.confs.slice(1).map((cs,idx)=>`<div style="flex:0 0 auto"><div style="font:700 11px system-ui;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em">${rotulo(idx+1)}</div>${cs.map((c,i)=>confHTML(c,idx+1,i)).join('')}</div>`).join('')
        + `</div>`;
    };
    if(t.tipo==='multi'){
      // uma chave por categoria, cada uma com seu campeão em `torneios.campeoes`
      const camp=Object.assign({}, t.campeoes||{}); let mudou=false;
      chaveH = cats.filter(c=>c.montada).map(c=>{
        const k=montar(ps.filter(p=>p.categoria===c.id), _tamCat(c), c.id);
        if(k.campeao && camp[c.id]!==k.campeao){ camp[c.id]=k.campeao; mudou=true; }
        return `<div style="font:700 12px system-ui;color:var(--gold);margin-top:14px;text-transform:uppercase;letter-spacing:.08em">${c.nome}</div>`+pintar(k,c.id);
      }).join('');
      // final confirmada → o dono grava o campeão da categoria; o torneio só
      // conclui quando TODAS as categorias montaram e todas têm campeão
      if(mudou && t.dono_id===MEU_UID){
        const fim = cats.length && cats.every(c=>c.montada && camp[c.id]);
        sb.from('torneios').update(Object.assign({campeoes:camp}, fim?{status:'concluido'}:{})).eq('id',id).then(()=>{});
      }
    } else {
      const k=montar(ps, t.tamanho, null);
      // final confirmada → o dono grava o campeão (4d entra em cima disso)
      if(k.campeao && t.status!=='concluido' && t.dono_id===MEU_UID){
        sb.from('torneios').update({status:'concluido',campeao_id:k.campeao}).eq('id',id).then(()=>{});
      }
      chaveH = pintar(k,null);
    }
  }
  // no multi quem fecha é a categoria: dá pra entrar numa enquanto outra já joga
  const inscricoesAbertas = t.tipo==='multi' ? cats.some(c=>!c.montada) : t.status==='inscricoes';
  const acao = !inscricoesAbertas
    ? ''
    : souParticipante
      ? `<button onclick="_net.sairTorneio('${id}')" style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--dn-bg);background:var(--dn-bg);color:#fff;font:600 13px system-ui;cursor:pointer;margin-top:14px">Sair do torneio</button>`
      : `<button onclick="_net.entrarTorneio('${id}')" style="width:100%;padding:12px;border-radius:11px;border:none;background:#2C5A00;color:#fff;font:700 13px system-ui;cursor:pointer;margin-top:14px">Entrar</button>`;
  // no multi o botão de montar vive dentro de cada categoria (na lista), porque
  // cada uma enche e monta no seu próprio ritmo
  const donoMonta = (t.tipo!=='multi' && t.dono_id===MEU_UID && cheio && t.status==='inscricoes')
    ? `<button onclick="_net.montarChave('${id}')" style="width:100%;padding:13px;border-radius:12px;border:none;background:var(--gold-bg);color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:10px">⚔️ Montar a chave</button>`
    : '';
  _sheet('net-tver', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">${t.nome}</div>
      <button onclick="_net.fecharTver()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 12px">${t.tipo==='multi'?(t.categorias||[]).length+' categorias':(t.esporte==='beach'?'Beach':'Tênis')} · mata-mata · ${ps.length}${t.tipo==='multi'?'':'/'+t.tamanho} inscritos · ${t.aberto?'aberto':'fechado'}${t.tipo==='restrito'&&t.classes?' · divisões '+t.classes.join('/'):''}${t.tipo==='aberto'?' · todas as divisões':''}</div>
    ${chaveH}
    ${lista||'<p style="color:var(--ink2);font-size:13px">Ninguém inscrito ainda.</p>'}
    ${acao}${donoMonta}
    ${inscricoesAbertas?`<button onclick="_net.copiarLinkTorneio('${id}')" style="width:100%;padding:12px;border-radius:11px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:10px">🔗 Copiar link de convite</button>
    <div style="font-size:11px;color:var(--ink3);text-align:center;margin-top:6px">Quem abrir o link entra direto, sem aprovação.</div>`:''}
    ${(t.dono_id===MEU_UID && t.status==='inscricoes')?`<button onclick="_net.editarTorneio('${id}')" style="width:100%;padding:11px;border-radius:11px;border:1px solid var(--linha2);background:var(--sup2);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:8px">⚙️ Editar regras</button>`:''}`);
}
function netFecharTver(){ const el=document.getElementById('net-tver'); if(el) el.remove(); }

/* ---- Login por email + senha (quem já tem conta) ---------------------- */
async function netEnviarLogin(email, senha){
  email=(email||'').trim();
  if(!email || !/@/.test(email)){ alert('Digite um email válido.'); return; }
  if(!senha){ alert('Digite sua senha.'); return; }
  const r = await netLogin(email, senha);
  if(r.erro){ alert('Não entrou: '+r.erro); return; }
  // logou → recarrega pra o boot hidratar a conta do banco
  location.reload();
}
/* (26/08) ACESSAR MINHA CONTA — tela do Figma (node 27:5).
   Medidas do desenho divididas por 2: o canvas é 1080 de largura, que é 2x.
   O símbolo vem de `marcas/ranket-r.png`, que o app já publica — nenhum asset
   novo entrou por esta tela.
   O olho da senha é `_net.olhoSenha`, e o "Cadastre-se" fecha a folha e abre o
   cadastro, que é o que o desenho promete ao pôr os dois na mesma tela. */
function netAbrirLogin(){
  _sheet('net-login', `
    <button onclick="document.getElementById('net-login').remove()"
      style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--ink2);font-size:26px;line-height:1;cursor:pointer">&times;</button>

    <div style="display:flex;align-items:center;gap:14px;margin:6px 0 26px">
      <img src="../marcas/ranket-r.png" alt="" style="width:39px;height:auto;display:block">
      <div>
        <div style="font:800 22px var(--f-disp),system-ui;color:#fff;line-height:1.1">Bem-vindo ao Ranket</div>
        <div style="font:400 14px system-ui;color:var(--ink2);margin-top:3px">Faça o login e acesse sua conta.</div>
      </div>
    </div>

    <input id="nl-email" type="email" placeholder="E-mail"
      style="width:100%;padding:14px 18px;border-radius:14px;border:1px solid rgba(255,254,253,.55);background:transparent;color:#fff;font:400 15px system-ui"
      autocomplete="email" inputmode="email" autocapitalize="off"/>

    <div style="position:relative;margin-top:12px">
      <input id="nl-senha" type="password" placeholder="Senha"
        style="width:100%;padding:14px 52px 14px 18px;border-radius:14px;border:1px solid rgba(255,254,253,.55);background:transparent;color:#fff;font:400 15px system-ui"
        autocomplete="current-password"/>
      <button onclick="_net.olhoSenha('nl-senha',this)" aria-label="Mostrar senha"
        style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--ink2);padding:12px;cursor:pointer;display:flex;align-items:center"><svg viewBox="0 0 35 23" width="19" height="13" fill="none" aria-hidden="true" style="display:block"><path d="M2.65 14.61C5.79 17.71 11.27 22 17.5 22s11.71-4.29 14.85-7.39c.83-.82 1.24-1.23 1.51-2.03.19-.57.19-1.6 0-2.17-.27-.8-.68-1.21-1.51-2.03C29.21 5.29 23.73 1 17.5 1S5.79 5.29 2.65 8.39c-.83.82-1.24 1.23-1.51 2.03-.19.57-.19 1.6 0 2.17.27.8.68 1.21 1.51 2.02Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.97 11.5c0 1.93 1.58 3.5 3.53 3.5s3.53-1.57 3.53-3.5S19.45 8 17.5 8s-3.53 1.57-3.53 3.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>

    <button onclick="_net.esqueciSenha(document.getElementById('nl-email').value)"
      style="background:none;border:none;color:#fff;font:400 12px system-ui;text-decoration:underline;cursor:pointer;padding:12px 0 0">Esqueci minha senha</button>

    <button onclick="_net.enviarLogin(document.getElementById('nl-email').value, document.getElementById('nl-senha').value)"
      style="width:100%;padding:16px;border-radius:14px;border:none;background:var(--marca);color:var(--marca-ink);font:800 15px system-ui;cursor:pointer;margin-top:18px">Entrar</button>

    <button onclick="document.getElementById('net-login').remove(); if(window.abrirCadastro) abrirCadastro();"
      style="width:100%;padding:16px;border-radius:14px;border:none;background:#121212;color:var(--ink2);font:400 15px system-ui;cursor:pointer;margin-top:12px">Ainda não tem conta? <b style="color:var(--ink2)">Cadastre-se</b></button>

    <p style="text-align:center;color:#fff;font:400 11px system-ui;margin:22px 0 2px;opacity:.75">O Ranket é somente para maiores de 18 anos.</p>`);
  const el=document.getElementById('nl-email'); if(el) el.focus();
}
/* O olho: alterna o tipo do campo e o próprio ícone. Preserva a posição do
   cursor — trocar `type` zera a seleção em alguns navegadores, e quem toca no
   olho está no meio da digitação. */
function netOlhoSenha(id, bt){
  const el=document.getElementById(id); if(!el) return;
  const pos=el.selectionStart;
  const mostrando = el.type==='text';
  el.type = mostrando ? 'password' : 'text';
  /* O estado sai pela COR (o `currentColor` do SVG), não por um segundo
     glifo: o desenho entregou UM ícone de olho e não a variante riscada, e
     inventar o olho cortado seria desenhar arte que o designer não fez. */
  if(bt){
    bt.style.color = mostrando ? 'var(--ink2)' : 'var(--acc)';
    bt.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Esconder senha');
  }
  el.focus();
  try{ el.setSelectionRange(pos,pos); }catch(e){}
}
window.netAbrirLogin = netAbrirLogin;

/* ---- Esqueci minha senha -------------------------------------------------
   Fluxo em duas pernas, com um dia de intervalo possível entre elas:

   1. Aqui: pede o email e manda o link. O `redirectTo` precisa estar na lista
      de Redirect URLs do Supabase (Authentication → URL Configuration) — se não
      estiver, o link cai na home do projeto e o app nunca vê a recuperação.
      Em teste isso inclui a URL de IP local, que muda a cada troca de rede.

   2. Quando o link é aberto, o supabase-js consome o token da URL e dispara
      PASSWORD_RECOVERY. Só aí a senha nova é digitada (netAbrirNovaSenha).

   Nesse meio o usuário JÁ ESTÁ com sessão válida — é assim que o Supabase
   funciona. Sem abrir a tela da senha nova, ele entraria no app e sairia
   achando que trocou a senha sem ter trocado nada. Por isso a detecção não
   pode depender só do evento: tem o exame do hash junto, logo abaixo.        */
async function netEsqueciSenha(email){
  email=(email||'').trim();
  if(!email || !/@/.test(email)){ alert('Digite o email da sua conta no campo acima e toque de novo.'); return; }
  const volta = location.origin + location.pathname;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: volta });
  if(error && /rate|limit|seconds/i.test(error.message)){
    alert('Muitos pedidos seguidos. Espere alguns minutos e tente de novo.'); return;
  }
  if(error) console.warn('[net] reset de senha:', error.message);
  const el=document.getElementById('net-login'); if(el) el.remove();
  // Resposta IGUAL existindo ou não a conta: dizer "esse email não tem cadastro"
  // entrega a lista de quem é cadastrado pra quem só tem o endereço.
  alert('Se houver uma conta com esse email, o link já foi enviado.\n\nAbra o link NESTE aparelho — é ele que conhece o app.');
}

function netAbrirNovaSenha(){
  _sheet('net-nova-senha', `<div style="font:700 17px system-ui">Definir uma nova senha</div>
    <div style="font-size:12px;color:var(--ink2);margin:8px 0 12px">Escolha a senha nova. Depois disso você já entra direto.</div>
    <input id="ns-1" type="password" placeholder="nova senha" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui" autocomplete="new-password"/>
    <input id="ns-2" type="password" placeholder="repita a nova senha" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;margin-top:10px" autocomplete="new-password"/>
    <button onclick="_net.salvarNovaSenha(document.getElementById('ns-1').value, document.getElementById('ns-2').value)" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:12px">Salvar senha</button>`);
  const el=document.getElementById('ns-1'); if(el) el.focus();
}

async function netSalvarNovaSenha(s1, s2){
  if((s1||'').length < 6){ alert('A senha precisa ter pelo menos 6 caracteres.'); return; }
  if(s1 !== s2){ alert('As duas senhas não são iguais.'); return; }
  const { error } = await sb.auth.updateUser({ password:s1 });
  if(error){ alert('Não deu pra trocar a senha: '+error.message); return; }
  const el=document.getElementById('net-nova-senha'); if(el) el.remove();
  history.replaceState(null,'',location.pathname);   // tira o token da barra
  alert('Senha trocada. Você já está conectado.');
}

/* Duas redes pra pegar a recuperação, porque falhar aqui é silencioso.
   O evento cobre os dois fluxos do Supabase (implicit e PKCE); o exame do hash
   cobre o caso de o evento já ter disparado antes deste arquivo registrar o
   ouvinte. Abrir a folha duas vezes não faz mal — _sheet reusa o mesmo id. */
sb.auth.onAuthStateChange((ev)=>{ if(ev === 'PASSWORD_RECOVERY') netAbrirNovaSenha(); });
if(/type=recovery/.test(location.hash) || /type=recovery/.test(location.search)){
  setTimeout(netAbrirNovaSenha, 400);
}

/* ---- Convite por LINK (entra direto, sem aprovação) ------------------- */
function netLinkTorneio(id){ return location.origin + location.pathname + '?t=' + id; }
async function netCopiarLinkTorneio(id){
  const url = netLinkTorneio(id);
  try{ await navigator.clipboard.writeText(url); if(window.toast) toast('Link copiado! Cole pro amigo — ele entra direto, sem aprovação.'); }
  catch(e){ prompt('Copie o link e mande pro amigo:', url); }
}
// no boot: se a URL trouxe ?t=<torneio>, entra direto nele
async function netEntrarPorLink(){
  if(!MEU_UID) return;
  const p = new URLSearchParams(location.search);
  /* convite de AMIZADE (?a=<uid de quem convidou>)
     13/08: abrir o link não fecha mais a amizade — manda um pedido pra quem
     convidou. Custa um toque a mais pra ele, e é o certo: link circula em
     grupo e vai parar em qualquer um, então quem convidou confirma quem de
     fato apareceu. */
  const aUid = p.get('a');
  if(aUid){ history.replaceState(null,'',location.pathname);
    if(aUid!==MEU_UID){ try{ window.aplicarJogadoresReais && aplicarJogadoresReais(await netAdversarios()); }catch(e){} await netPedirAmizade(aUid); }
    return; }
  // convite de GRUPO (?g=<token>)
  const gTok = p.get('g');
  if(gTok){ history.replaceState(null,'',location.pathname); await netEntrarGrupoPorLink(gTok); return; }
  const t = p.get('t');
  if(!t) return;
  history.replaceState(null,'',location.pathname);
  const ex = await sb.from('torneio_participantes').select('player_id').eq('torneio_id',t).eq('player_id',MEU_UID);
  if(!(ex.data&&ex.data.length)){
    // o link respeita as regras do torneio: restrito filtra por divisão, multi pede a categoria
    await netEntrarTorneio(t);
  }
  setTimeout(()=>{ try{ netVerTorneio(t); }catch(e){} }, 500);
}
window.netEntrarPorLink = netEntrarPorLink;

/* =========================================================================
   LOCALIZAÇÃO (11/08) — migração 19, que estava toda órfã: o banco tinha
   cidades/locais/player_locais e o app não lia nada. A cidade NUNCA é campo
   digitado — deriva do clube onde a pessoa joga, que é o que ela sabe
   escolher numa lista (texto livre vira "Salvador"/"SSA" em uma semana e aí
   não filtra nada, que era a única razão de existir).
   ========================================================================= */
let _locais = null;      // todos os locais ativos, com o nome da cidade colado
/* ids de local que o inbox já tentou resolver e não achou — quase sempre clube
   que o ADM desativou depois de a partida ser marcada. Sem esta marca, cada
   atualização do inbox pediria a lista de novo pelo mesmo id que nunca vem. */
const _locTentados = new Set();
let _meusLocais = null;  // [{local_id, principal}] — os MEUS
let _cidades = [];       // cidades cadastradas, pro cadastro de quadra particular
let _mapaLoc = null;     // player_id → {local_id, cidade_id, regiao_id} (view player_cidade)

/* 13/08: o embed do PostgREST volta objeto ou array conforme a cardinalidade
   que ele infere da relação. Tolerar as duas formas é mais barato que depender
   da inferência dele continuar a mesma. */
const _endDe = (e)=> (Array.isArray(e) ? (e[0]||{}) : (e||{})).endereco || null;

async function netLocais(force){
  if(_locais && !force) return _locais;
  const [ls, cs, rs] = await Promise.all([
    /* 13/08: o endereço saiu de `locais` e virou linha própria em
       `locais_endereco`, com fechadura própria (migração 25). Vem embutido:
       quem não tem direito simplesmente não recebe a linha e o campo fica
       null — sem erro e sem tela quebrada. */
    sb.from('locais')
      // 18/08: `telefone` entra (existe desde a mig 28 e nunca foi lido) — é o
      // que faltava pro perfil do clube ter o que mostrar.
      // 25/08 (mig 59): `locacao` — o lugar aluga pra quem não é sócio? É o
      // que a categoria Lugares do Encontrar mostra, e o que responde ao
      // pedido do Rege de "botar o cara na cara do gol".
      .select('id,nome,tipo,quadras,cidade_id,regiao_id,origem,dono_id,telefone,locacao,locais_endereco(endereco)')
      .eq('ativo',true).order('nome'),
    sb.from('cidades').select('id,nome,uf'),
    sb.from('regioes').select('id,nome,cidade_id'),
  ]);
  /* 13/08: `ls.data || []` transformava QUALQUER erro em lista vazia — e lista
     vazia aqui não é erro, é a frase "Nenhum clube cadastrado ainda". Pior: a
     guarda do topo trata [] como cache bom e congela o vazio pela sessão
     inteira, e o filtro "Minha cidade" do radar passa a comparar contra null e
     ESVAZIA o radar de quem declarou clube. Tudo isso sem uma linha de erro na
     tela. Erro tem que deixar `_locais` nulo, pra próxima chamada tentar de
     novo. Onde o vazio tem significado de produto, o erro precisa de caminho
     próprio. */
  if(ls.error){ console.error('[net] locais', ls.error); _locais = null; return []; }
  const cid = {}; (cs.data||[]).forEach(c=>cid[c.id]=c);
  const reg = {}; (rs.data||[]).forEach(r=>reg[r.id]=r);
  // 18/08: a lista de cidades já vinha nesta consulta e era jogada fora depois
  // de colar o rótulo. O cadastro de quadra particular precisa dela pra perguntar
  // em que cidade fica — sem isso seria mais uma consulta pelo mesmo dado.
  _cidades = (cs.data||[]).slice().sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
  /* O NOME da região vem colado aqui, e não numa consulta na hora de desenhar:
     o render do radar é síncrono (não pode esperar query) e precisa do rótulo
     pro chip. Mesma razão pela qual a cidade já vinha colada. */
  _locais = ls.data.map(l=>({ ...l,
    endereco: _endDe(l.locais_endereco),
    cidade: cid[l.cidade_id] ? `${cid[l.cidade_id].nome}/${cid[l.cidade_id].uf}` : '',
    regiao: reg[l.regiao_id] ? reg[l.regiao_id].nome : null }));
  return _locais;
}

/* 13/08: onde dá pra marcar jogo. A migração 25 só aceita `local_id` de clube
   do ADM ou de quadra SUA — porque quem escolhe o local escolhe quem enxerga o
   endereço dele. Filtrar aqui é cortesia: quem manda é o trigger. */
const _locaisMarcaveis = ()=> (_locais||[]).filter(l=> l.origem !== 'jogador' || l.dono_id === MEU_UID);
const _locDe   = (id)=> (_locais||[]).find(l=>l.id===id) || null;
const _locNome = (id)=> { const l=_locDe(id); return l ? l.nome : null; };

/* 16/08: o endereço embaixo do seletor de local.
   `_locais` já traz `endereco` normalizado do `locais_endereco` (mig 25), e a
   RLS decide quem recebe a linha: clube do ADM é público, quadra particular
   alheia só depois que o desafio chega. Então a tela não filtra nada — mostra
   o que veio.

   O que ela NÃO pode fazer é confundir os dois vazios. `endereco` ausente aqui
   significa uma de duas coisas bem diferentes: o clube não tem endereço
   cadastrado, ou eu não tenho direito de ver ainda. Dizer "sem endereço" nos
   dois casos ensinaria que a quadra do outro não tem endereço — e ela tem, eu
   é que não posso ver. Por isso quadra particular que não é minha tem texto
   próprio. É o mesmo cuidado do `x.data || []`: vazio por regra e vazio por
   ausência não podem ser o mesmo pixel. */
function _endLinha(l){
  if(!l) return '';
  const box = (txt, cor) => `<div style="font-size:11px;color:${cor};margin-top:6px;line-height:1.45">${txt}</div>`;
  if(l.endereco) return box(`📍 ${l.endereco}`, 'var(--ink2)');
  if(l.origem === 'jogador' && l.dono_id !== MEU_UID)
    return box('📍 O endereço aparece pra ele quando o desafio chegar.', 'var(--ink3)');
  return box('📍 Sem endereço cadastrado ainda.', 'var(--ink3)');
}

async function netMeusLocais(force){
  if(_meusLocais && !force) return _meusLocais;
  if(!MEU_UID) return [];
  const r = await sb.from('player_locais').select('local_id,principal').eq('player_id', MEU_UID);
  /* 18/08: `r.data || []` transformava QUALQUER erro em lista vazia — e vazio
     aqui é truthy, então a guarda do topo congelava o vazio pela sessão inteira.
     Era o mesmo defeito que o `netLocais` já tinha consertado em 13/08, e aqui
     ele passou batido porque nada destrutivo encostava nesta lista.

     O Apagar do item 32 mudou isso: a folha "onde você joga" reabre logo depois
     de apagar uma quadra. Se este fetch falhar nessa hora, ela reabre com TUDO
     desmarcado, e um toque em Salvar manda `netSalvarMeusLocais([], null)` —
     que apaga todos os `player_locais` da pessoa e ainda canta "Locais salvos.".
     Erro tem que deixar `_meusLocais` nulo, pra próxima chamada tentar de novo. */
  if(r.error){ console.error('[net] meusLocais', r.error); _meusLocais = null; return []; }
  _meusLocais = r.data || [];
  _locPublicar();
  return _meusLocais;
}
/* O render das telas locais (ficha, quadro, radar) é síncrono — ele não pode
   esperar query. Então o que ele lê é este espelho em window, atualizado
   sempre que a lista muda. */
function _locPublicar(){
  const pr = (_meusLocais||[]).find(x=>x.principal) || (_meusLocais||[])[0] || null;
  const l  = pr ? _locDe(pr.local_id) : null;
  window.__meusLocais = {
    ids: (_meusLocais||[]).map(x=>x.local_id),
    principal: pr ? pr.local_id : null,
    principalNome: l ? l.nome : null,
    cidadeId: l ? l.cidade_id : null,
    cidade: l ? l.cidade : null,
    // a região sai do local PRINCIPAL, como a cidade. Fica nula enquanto o ADM
    // não classificar o clube — e aí o chip de região nem aparece.
    regiaoId: l ? l.regiao_id : null,
    regiao: l ? l.regiao : null,
  };
  if(window.render){ try{ render(); }catch(e){} }
}
/* Regrava a lista inteira (apagar+inserir): são meia dúzia de linhas por
   pessoa e a RLS só deixa cada um mexer em si — mais simples que diff. */
async function netSalvarMeusLocais(ids, principalId){
  if(!MEU_UID) return { erro:'sem sessão' };
  ids = (ids||[]).filter(Boolean);
  const pr = principalId && ids.includes(principalId) ? principalId : ids[0] || null;
  await sb.from('player_locais').delete().eq('player_id', MEU_UID);
  if(ids.length){
    const { error } = await sb.from('player_locais')
      .insert(ids.map(id=>({ player_id:MEU_UID, local_id:id, principal:id===pr })));
    if(error) return { erro:error.message };
  }
  _meusLocais = ids.map(id=>({ local_id:id, principal:id===pr }));
  _locPublicar();
  return { ok:true };
}

/* Mapa jogador→lugar pro radar filtrar. A view só tem quem marcou principal —
   quem não marcou fica FORA do mapa e o radar nunca esconde essa pessoa:
   filtro que esvazia o pool é pior que filtro nenhum. */
async function netMapaLocais(force){
  if(_mapaLoc && !force) return _mapaLoc;
  const r = await sb.from('player_cidade').select('player_id,local_id,cidade_id,regiao_id');
  _mapaLoc = {};
  (r.data||[]).forEach(x=>{ _mapaLoc[x.player_id]=x; });
  window.__mapaLocais = _mapaLoc;
  return _mapaLoc;
}

/* ---- UI: "Onde eu jogo" — a MESMA folha serve o onboarding e a ficha ---- */
let _loc = null;
async function netAbrirMeusLocais(){
  await netLocais(); await netMeusLocais();
  const meus = _meusLocais||[];
  _loc = { sel: meus.map(x=>x.local_id),
           principal: (meus.find(x=>x.principal)||meus[0]||{}).local_id || null };
  netRenderMeusLocais();
}
function netFecharMeusLocais(){ _loc=null; const el=document.getElementById('net-locais'); if(el) el.remove(); }
function _locToggle(id){
  const i=_loc.sel.indexOf(id);
  if(i>=0){ _loc.sel.splice(i,1); if(_loc.principal===id) _loc.principal=_loc.sel[0]||null; }
  else { _loc.sel.push(id); if(!_loc.principal) _loc.principal=id; }
  netRenderMeusLocais();
}
function _locPrincipal(id){ if(_loc.sel.includes(id)) _loc.principal=id; netRenderMeusLocais(); }
async function _locSalvar(){
  const r = await netSalvarMeusLocais(_loc.sel, _loc.principal);
  if(r.erro){ alert('Não deu pra salvar: '+r.erro); return; }
  netFecharMeusLocais();
  if(window.toast) toast(window.__meusLocais.principalNome
    ? `📍 Você joga no <b>${window.__meusLocais.principalNome}</b>.`
    : 'Locais salvos.');
}
function netRenderMeusLocais(){
  const TIPO={clube:'clube',condominio:'condomínio',publico:'quadra pública',academia:'academia',outro:''};
  /* `_locaisMarcaveis()` e não `_locais` cru: a lista mostrava também as quadras
     PARTICULARES dos outros, e marcar uma delas como principal quebrava o
     Desafiar inteiro — o desafio nasce com `local_id` = principal, e a trava (0)
     do trigger recusa local que não é do clube nem meu. Escolha que o banco vai
     negar não é escolha; é um erro esperando a pessoa chegar. */
  const linhas=(_locaisMarcaveis()).map(l=>{
    const on=_loc.sel.includes(l.id), pr=_loc.principal===l.id;
    return `<div style="display:flex;align-items:center;gap:10px;padding:11px 2px;border-bottom:1px solid var(--sup2)">
      <button onclick="_net.locToggle('${l.id}')" style="width:24px;height:24px;border-radius:7px;border:1px solid ${on?'#2C5A00':'var(--linha2)'};background:${on?'#2C5A00':'var(--bg)'};color:#fff;font:700 13px system-ui;cursor:pointer;flex:0 0 24px">${on?'✓':''}</button>
      <!-- 18/08: o nome virou porta pro perfil do clube (item 30). O toque no
           nome NÃO pode marcar/desmarcar — quem quer ver o clube não quer mudar
           onde joga, e o checkbox continua sendo o único jeito de marcar. -->
      <div onclick="_net.verLocal('${l.id}')" style="flex:1;min-width:0;cursor:pointer">
        <b style="font-size:14px">${l.nome}</b> <span style="color:var(--ink3);font-size:11px">›</span>
        <div style="font-size:11px;color:var(--ink2)">${TIPO[l.tipo]||''}${TIPO[l.tipo]?' · ':''}${l.quadras} quadra${l.quadras>1?'s':''}${l.cidade?' · '+l.cidade:''}</div>
        ${l.endereco?`<div style="font-size:10.5px;color:var(--ink3)">${l.endereco}</div>`:''}</div>
      ${on?`<button onclick="_net.locPrincipal('${l.id}')" style="padding:6px 10px;border-radius:9px;border:1px solid ${pr?'var(--gold-bg)':'var(--linha2)'};background:${pr?'var(--gold-bg)':'var(--sup2)'};color:${pr?'var(--gold)':'var(--ink2)'};font:600 11px system-ui;cursor:pointer">${pr?'★ principal':'tornar principal'}</button>`:''}
    </div>`;
  }).join('');
  _sheet('net-locais', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">📍 Onde você joga</div>
      <button onclick="_net.fecharLocais()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 8px">Marque os lugares onde você costuma jogar. O <b>principal</b> vira o endereço dos seus desafios e diz sua cidade — dá pra jogar em mais de um. Toque no nome pra ver o clube por dentro.</div>
    ${linhas || '<p style="color:var(--ink2);font-size:13px;margin:14px 0">Nenhum clube cadastrado ainda. Fala com o ADM do app pra incluir o seu — ou cadastre sua quadra aqui embaixo.</p>'}
    <!-- 18/08 (item 31): a quadra particular tinha coluna, fechadura e policies
         desde a migração 25 e nunca teve porta. Aqui é o lugar dela: quem abre
         "onde você joga" e não acha o próprio lugar é exatamente quem precisa. -->
    <button onclick="_net.criarQuadra()" style="width:100%;padding:13px;border-radius:12px;border:1px dashed var(--linha2);background:var(--sup);color:var(--ink);font:700 13px system-ui;cursor:pointer;margin-top:14px">+ Cadastrar minha quadra</button>
    <button onclick="_net.locSalvar()" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:8px">Salvar</button>`);
}

/* =========================================================================
   ITEM 30 (18/08) — O PERFIL DO CLUBE
   `telefone` ganhou coluna na migração 28 e nunca teve onde aparecer; o
   endereço vive em `locais_endereco` com fechadura própria desde a 25. A tela
   é a leitura que faltava pro par ficar completo.

   O endereço só aparece pra quem a policy `locais_endereco_sel` deixou ver —
   quando não veio, a folha DIZ que não veio em vez de fingir que não existe.
   ========================================================================= */
function netVerLocal(id){
  const l = _locDe(id);
  if(!l){ alert('Local não encontrado.'); return; }
  const TIPO={clube:'Clube',condominio:'Condomínio',publico:'Quadra pública',academia:'Academia',outro:'Quadra'};
  const meu = l.dono_id === MEU_UID;
  const linha = (ic, txt, cor)=>`<div style="display:flex;gap:9px;align-items:flex-start;margin-top:10px">
      <span style="flex:0 0 18px;font-size:13px">${ic}</span>
      <div style="flex:1;min-width:0;font-size:12.5px;color:${cor||'var(--ink)'};line-height:1.45">${txt}</div></div>`;
  /* o telefone vira link de discar: ver um número que não disca em tela de
     celular é pedir pra pessoa decorar e digitar em outro app. */
  const tel = (l.telefone||'').trim();
  const telLink = tel ? `<a href="tel:${_admEsc(tel.replace(/[^\d+]/g,''))}" style="color:var(--lime);text-decoration:none">${_admEsc(tel)}</a>` : '';
  _sheet('net-local', `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="min-width:0">
        <div style="font:700 17px system-ui">${_admEsc(l.nome)}</div>
        <div style="font-size:12px;color:var(--ink2);margin-top:2px">${TIPO[l.tipo]||'Quadra'}${l.cidade?' · '+_admEsc(l.cidade):''}${l.regiao?' · '+_admEsc(l.regiao):''}</div>
      </div>
      <button onclick="_net.fecharLocal()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer;flex:0 0 auto">×</button></div>

    <div style="border:1px solid var(--linha);border-radius:12px;padding:12px 13px;margin-top:14px">
      ${linha('🎾', `<b>${l.quadras}</b> quadra${l.quadras>1?'s':''}`)}
      ${l.endereco
        ? linha('📍', _admEsc(l.endereco))
        : (l.origem==='jogador' && !meu
            ? linha('📍', 'O endereço aparece pra você quando o desafio chegar.', 'var(--ink3)')
            : linha('📍', 'Sem endereço cadastrado ainda.', 'var(--ink3)'))}
      ${tel ? linha('📞', telLink) : linha('📞', 'Sem telefone cadastrado.', 'var(--ink3)')}
    </div>

    ${l.origem==='jogador'
      ? `<p style="font-size:11px;color:var(--ink3);margin-top:12px;line-height:1.5">${meu
          ? 'Quadra sua. O endereço só aparece pra quem você desafiar.'
          : 'Quadra particular de outro jogador.'}</p>`
      : ''}
    ${meu && l.origem==='jogador'
      ? `<div style="display:flex;gap:8px;margin-top:14px">
           ${_btn('Editar', `_net.editarQuadra('${l.id}')`)}
           ${_btn('Apagar', `_net.apagarQuadra('${l.id}')`, 'no')}
         </div>`
      : ''}`);
}
function netFecharLocal(){ const el=document.getElementById('net-local'); if(el) el.remove(); }

/* =========================================================================
   ITEM 31 (18/08) — CADASTRAR A PRÓPRIA QUADRA
   As policies `locais_jogador_ins` / `locais_endereco_ins` (mig 25) exigem
   `origem='jogador'` e `dono_id = auth.uid()`. O endereço é OBRIGATÓRIO aqui e
   não é zelo: quadra particular sem endereço não serve pra marcar jogo, e o
   desafio nasce com o local principal — cadastrar sem endereço só criaria uma
   linha que decepciona depois.

   O desfazer copia o do ADM: se o endereço não gravar, o local volta atrás.
   Sem isso sobraria um local mudo que a pessoa nem sabe que criou.
   ========================================================================= */
let _qnova = null;
function netCriarQuadra(){
  const meu = window.__meusLocais || {};
  _qnova = { id:null, nome:'', tipo:'condominio', quadras:1, endereco:'',
             cidade_id: meu.cidadeId || (_cidades[0]||{}).id || null };
  netRenderCriarQuadra();
}

/* =========================================================================
   ITEM 32 — EDITAR E APAGAR A PRÓPRIA QUADRA

   As policies `locais_jogador_upd`, `locais_endereco_upd` e `locais_jogador_del`
   existem desde a migração 25 e passaram na prova de RLS pelos DOIS lados. Só
   que nenhuma tinha botão: dava pra cadastrar e não dava pra corrigir nem
   apagar. Como o cadastro exige endereço, quem digitasse errado ficava preso
   com ele — e o endereço é justamente o que o desafiado usa pra chegar.

   É o espelho do que a tela de moderação ensinou hoje: lá nasceu um botão sem
   visão pra usar, aqui uma fechadura sem botão pra abrir. Fechadura provada e
   sem superfície não protege nada, só dorme.

   `_qnova.id` null = cadastrando, uuid = editando. O formulário é o mesmo de
   propósito: são os mesmos campos e as mesmas regras, e duplicar a folha faria
   as duas divergirem no primeiro conserto que só uma recebesse.
   ========================================================================= */
function netEditarQuadra(id){
  const l = _locDe(id);
  if(!l){ alert('Quadra não encontrada.'); return; }
  if(l.dono_id !== MEU_UID){ alert('Essa quadra não é sua.'); return; }
  _qnova = { id:l.id, nome:l.nome||'', tipo:l.tipo||'condominio',
             quadras:l.quadras||1, endereco:l.endereco||'',
             cidade_id:l.cidade_id||null,
             /* guardados pra comparar na hora de gravar: `cidade0` decide se a
                região tem que ser zerada (região pertence a uma cidade, e nada
                no banco amarra as duas — mig 19), e `quadras0` decide se vale
                conferir partida apontando pra quadra que deixou de existir. */
             cidade0:l.cidade_id||null, quadras0:l.quadras||1 };
  netFecharLocal();
  netRenderCriarQuadra();
}
function netFecharQnova(){ _qnova=null; const el=document.getElementById('net-qnova'); if(el) el.remove(); }
/* `_sheet` faz `innerHTML =` inteiro, então cada tecla destrói o <input> em foco
   — no celular o teclado fecha a cada letra. A casa já resolve isso no painel do
   ADM devolvendo o foco depois do render; aqui vai um passo além e devolve a
   POSIÇÃO do cursor, não o fim do texto: corrigir endereço é digitar no meio, e
   pular pro fim a cada tecla embaralharia justamente o caso que o Editar existe
   pra atender. */
let _qfoco = null;
function _qset(campo, v, pos){
  if(!_qnova) return;
  _qnova[campo] = (campo==='quadras') ? Math.max(1, Math.min(20, +v||1)) : v;
  _qfoco = (campo==='nome' || campo==='endereco')
    ? { campo, pos: (pos==null ? String(v).length : pos) } : null;
  netRenderCriarQuadra();
}
function netRenderCriarQuadra(){
  const q=_qnova; if(!q) return;
  const TIPOS=[['condominio','Condomínio'],['clube','Clube'],['publico','Pública'],['academia','Academia'],['outro','Outra']];
  const pronto = q.nome.trim() && q.endereco.trim() && q.cidade_id;
  const seg = TIPOS.map(([v,n])=>`<button onclick="_net.qset('tipo','${v}')" style="flex:1;padding:9px 4px;border-radius:9px;border:1px solid var(--linha2);font:600 11px system-ui;cursor:pointer;background:${q.tipo===v?'#2C5A00':'var(--sup2)'};color:#fff">${n}</button>`).join('');
  _sheet('net-qnova', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">${q.id?'Editar minha quadra':'Cadastrar minha quadra'}</div>
      <button onclick="_net.fecharQnova()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 12px">${q.id
      ? 'Corrigir aqui muda o endereço pra quem já foi desafiado também — é a mesma linha que eles leem.'
      : 'A quadra do seu prédio, do condomínio ou a que você aluga. Ela é <b>sua</b>: não entra na busca dos outros, e o endereço só aparece pra quem você desafiar.'}</div>

    <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">Nome</div>
    <input id="q-nome" value="${_admEsc(q.nome)}" oninput="_net.qset('nome',this.value,this.selectionStart)" placeholder="Ex.: Quadra do Ed. Aurora" maxlength="60"
      style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui" autocomplete="off"/>

    <div style="font-size:12px;color:var(--ink2);margin:12px 0 6px">Tipo</div>
    <div style="display:flex;gap:6px">${seg}</div>

    <div style="font-size:12px;color:var(--ink2);margin:12px 0 6px">Endereço <span style="color:var(--dn)">— obrigatório</span></div>
    <input id="q-endereco" value="${_admEsc(q.endereco)}" oninput="_net.qset('endereco',this.value,this.selectionStart)" placeholder="Rua, número e bairro" maxlength="160"
      style="width:100%;padding:12px;border-radius:12px;border:1px solid ${q.endereco.trim()?'var(--linha2)':'var(--dn)'};background:var(--bg);color:#fff;font:600 14px system-ui" autocomplete="off"/>

    <div style="display:flex;gap:10px;margin-top:12px">
      <div style="flex:1">
        <div style="font-size:12px;color:var(--ink2);margin-bottom:6px">Cidade</div>
        <select onchange="_net.qset('cidade_id',this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui">
          ${_cidades.map(c=>`<option value="${c.id}" ${q.cidade_id===c.id?'selected':''}>${_admEsc(c.nome)}/${_admEsc(c.uf)}</option>`).join('')
            || '<option value="">nenhuma cidade cadastrada</option>'}
        </select>
      </div>
      <div style="flex:0 0 96px">
        <div style="font-size:12px;color:var(--ink2);margin-bottom:6px">Quadras</div>
        <input type="number" min="1" max="20" value="${q.quadras}" oninput="_net.qset('quadras',this.value)"
          style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui"/>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-top:16px">
      ${_btn('Cancelar','_net.fecharQnova()')}
      ${pronto?_btn(q.id?'Salvar':'Cadastrar','_net.qsalvar()','ok'):''}
    </div>
    ${pronto?'':'<p style="font-size:11px;color:var(--ink3);text-align:center;margin-top:10px">Falta o nome ou o endereço.</p>'}`);

  // devolve foco e cursor pro campo que estava sendo digitado (ver _qset)
  if(_qfoco){
    const el = document.getElementById('q-'+_qfoco.campo);
    if(el){ el.focus(); const p = Math.min(_qfoco.pos, el.value.length); el.setSelectionRange(p, p); }
  }
}
/* Trava de toque duplo, compartilhada pelo Salvar e pelo Apagar. Os dois abrem
   diálogo DEPOIS de um round-trip de rede, então o segundo toque não é
   impaciência: é a pessoa achando, com razão, que o primeiro não pegou. Sem
   isto o segundo DELETE volta com zero linhas e o guarda de zero-linhas acusa
   "essa quadra não é sua" — mentira, e das que assustam. A casa já usa o mesmo
   padrão no chat (`_chatEnviar`, "trava o toque duplo"). */
let _qbusy = false;
async function _qsalvar(){
  if(_qbusy) return;
  _qbusy = true;
  try { await _qsalvarInterno(); } finally { _qbusy = false; }
}
async function _qsalvarInterno(){
  const q=_qnova; if(!q) return;
  const nome=q.nome.trim(), endereco=q.endereco.trim();
  if(!nome || !endereco || !q.cidade_id) return;

  /* EDITAR — a ordem é a INVERSA da do cadastro, e de propósito. No INSERT o
     desfazer é apagar o que acabou de nascer; aqui o local já existia antes,
     então apagar não seria rollback, seria estrago. Sem desfazer possível, o
     jeito de não deixar meia-escrita é gravar primeiro o campo que pode ser
     RECUSADO — o endereço, que tem fechadura própria (`locais_endereco_upd`).
     Se ele falhar, nada mudou e a folha continua aberta com o que a pessoa
     digitou; a metade que sobra é a menos danosa das duas.

     `.select('id')` nos dois: sem ele, update barrado pela RLS volta SEM erro e
     com zero linhas, e a tela cantaria "atualizada" tendo mudado nada. Erro
     silencioso é o único tipo que este projeto já viu passar batido. */
  if(q.id){
    /* ENCOLHER O NÚMERO DE QUADRAS. `matches.quadra` só é checado contra 1..60
       no banco (mig 19) — nada amarra ele ao `locais.quadras`. Baixar de 4 pra 2
       deixa o card de um jogo marcado imprimindo "Quadra 4" num lugar que não
       tem mais. Avisa e deixa seguir: encolher pode ser exatamente o certo (a
       quadra foi desativada), e a decisão é de quem é dono. */
    if(q.quadras < (q.quadras0||q.quadras)){
      const alta = await sb.from('matches').select('id', { count:'exact', head:true })
        .eq('local_id', q.id).in('status', ['desafiado','aceito']).gt('quadra', q.quadras);
      if(alta.error){ alert('Não deu pra conferir os jogos marcados: '+alta.error.message); return; }
      if(alta.count && !confirm(`${alta.count} jogo${alta.count>1?'s':''} marcado${alta.count>1?'s':''} aponta${alta.count>1?'m':''} pra uma quadra acima da ${q.quadras}.\n\n`
        + `Eles vão continuar mostrando um número que não existe mais aqui. Salvar assim mesmo?`)) return;
    }

    const end = await sb.from('locais_endereco')
      .upsert({ local_id:q.id, endereco }, { onConflict:'local_id' }).select('local_id');
    if(end.error){ alert('Não deu pra gravar o endereço: '+end.error.message); return; }
    if(!end.data || !end.data.length){ alert('O endereço não foi gravado — essa quadra não é sua ou não existe mais.'); return; }

    /* A região pertence a uma CIDADE, e nada no banco amarra as duas (mig 19).
       Mudou de cidade, a região que o ADM tinha classificado passa a ser de
       outro lugar — e o chip de região do radar casaria a pessoa com jogadores
       da cidade errada. Zera só quando a cidade muda: zerar sempre apagaria a
       classificação do ADM a cada correção de nome, que é estrago de outro tipo. */
    const campos = { nome, tipo:q.tipo, quadras:q.quadras, cidade_id:q.cidade_id };
    if(q.cidade0 && q.cidade_id !== q.cidade0) campos.regiao_id = null;

    const upd = await sb.from('locais').update(campos).eq('id', q.id).select('id');

    /* Os dois caminhos de erro daqui pra baixo REFRESCAM o cache antes de sair.
       Sem isso `_locais` fica com o endereço velho pelo resto da sessão — e o
       estrago não é só a tela divergir: reabrir o Editar carrega `l.endereco`
       do cache velho e o próximo upsert REGRAVA o endereço antigo por cima do
       novo, calado. Perda de dado de verdade, não de exibição. */
    if(upd.error){
      await netLocais(true);
      alert(upd.error.code === '23505'
        ? `Você já tem uma quadra com esse nome. O endereço foi gravado; escolha outro nome pra terminar.`
        : 'O endereço gravou, mas o resto não: '+upd.error.message);
      return;
    }
    if(!upd.data || !upd.data.length){
      await netLocais(true);
      alert('O endereço gravou, mas o resto não mudou — essa quadra não é sua.');
      return;
    }

    netFecharQnova();
    await netLocais(true); await netMeusLocais(true);
    if(window.toast) toast(`📍 <b>${_admEsc(nome)}</b> atualizada.`);
    if(document.getElementById('net-locais')) netAbrirMeusLocais();
    return;
  }

  const novo = await sb.from('locais').insert({
    nome, cidade_id:q.cidade_id, tipo:q.tipo, quadras:q.quadras,
    origem:'jogador', dono_id:MEU_UID,
  }).select('id').single();
  if(novo.error){ alert('Não deu pra cadastrar: '+novo.error.message); return; }
  const end = await sb.from('locais_endereco').insert({ local_id:novo.data.id, endereco });
  if(end.error){
    const volta = await sb.from('locais').delete().eq('id', novo.data.id);
    alert('A quadra foi criada mas o endereço não gravou: '+end.error.message
      + (volta.error
          ? `\n\n⚠️ E não deu pra desfazer (${volta.error.message}) — "${nome}" ficou cadastrada SEM endereço.`
          : '\n\nNada foi cadastrado. Pode tentar de novo.'));
    return;
  }
  netFecharQnova();
  await netLocais(true); await netMeusLocais(true);

  /* (26/08) A MESMA FOLHA ATENDE DUAS TELAS AGORA. Quem chamou pode ser o
     cadastro (passo 3, "onde você joga" / "onde você dá aula") ou a Ficha ›
     Meus locais. O padrão do arquivo é perguntar quem está na tela antes de
     avisar — o `if` de Meus locais logo abaixo já fazia isso, e o do cadastro
     segue a mesma forma em vez de inventar um segundo mecanismo.

     No cadastro a quadra nasce MARCADA e o toast muda: mandar "marque ela em
     onde você joga" pra quem está justamente nessa tela, com ela já marcada,
     seria instrução pra fazer o que acabou de ser feito. */
  const noCadastro = (document.getElementById('onb')||{}).classList
                   && document.getElementById('onb').classList.contains('on');
  if(noCadastro && window.onbQuadraCriada){
    window.onbQuadraCriada(novo.data.id);
    if(window.toast) toast(`📍 <b>${nome}</b> cadastrada e marcada.`);
  } else if(window.toast){
    toast(`📍 <b>${nome}</b> cadastrada. Marque ela em "onde você joga".`);
  }
  // a folha de trás está com a lista velha em mãos: redesenha com a quadra nova
  if(document.getElementById('net-locais')) netAbrirMeusLocais();
}

/* APAGAR — o banco já resolve o passado sozinho: `matches.local_id` é
   `on delete set null` (mig 19), então placar e rating de partida jogada
   continuam valendo, e é assim que tem que ser — partida é histórico.

   O que o banco NÃO resolve é o jogo que ainda vai acontecer. Ali o `set null`
   trabalha contra: a partida perde o local em silêncio, o card do outro jogador
   fica sem endereço e ele aparece em lugar nenhum. Por isso o futuro BARRA e o
   passado não — quem já jogou não perde nada, quem AINDA VAI jogar não
   consentiu com o sumiço do endereço. Cancelar o desafio é decisão dele
   também, e existe caminho pra isso (`desafio_cancelar`, mig 36).

   O `quando is null` entra na conta junto: a migração 34 proibiu desafio novo
   sem data, mas os "a combinar" gravados antes continuam válidos, e um desafio
   sem data é tão marcado quanto os outros. Filtrar só por `gte` deixaria
   justamente os mais antigos passarem despercebidos. */
async function netApagarQuadra(id){
  if(_qbusy) return;
  _qbusy = true;
  try { await _netApagarQuadraInterno(id); } finally { _qbusy = false; }
}
async function _netApagarQuadraInterno(id){
  const l = _locDe(id);
  if(!l){ alert('Quadra não encontrada.'); return; }
  if(l.dono_id !== MEU_UID){ alert('Essa quadra não é sua.'); return; }

  /* A conta enxerga tudo que precisa: numa quadra particular só o dono cria
     partida (a trava de 13/08 do `matches_guard`), e `matches_select` devolve
     as partidas de quem pergunta — então o dono vê 100% dos jogos marcados
     ali. Se um dia outra pessoa puder marcar na quadra alheia, esta conta
     passa a ser parcial e o aviso vira mentira. */
  /* A JANELA É DE -12h, NÃO DE AGORA. A partida não morre no horário marcado:
     o W.O. só é apurado 12h depois (`netApurarWO`), e nesse intervalo ela está
     viva — dá pra assinar presença e lançar placar. Cortar em `now()` deixaria
     de fora justamente o jogo de ontem à noite que ainda vai ser lançado.

     `quando is null` entra junto: a migração 34 proibiu desafio novo sem data,
     mas os "a combinar" gravados antes continuam válidos, e sem data um desafio
     é tão marcado quanto os outros. */
  const limite = new Date(Date.now() - 12*3600*1000).toISOString();

  /* DUAS CONTAS, não uma. A contraproposta grava só `prop_local_id` e não toca
     em `local_id` (mig 27) — então uma quadra minha oferecida numa contraproposta
     não aparece contando por `local_id`. Se ela for apagada, o `on delete set
     null` limpa o `prop_local_id`, e quando o outro aceitar, o
     `contraproposta_aceitar` copia `local_id = prop_local_id` = NULL: partida
     aceita, com data, e sem lugar nenhum. Exatamente o dano que esta função
     existe pra impedir, entrando por uma porta que ela não estava olhando.

     São duas queries em vez de um `or` de dois campos com janelas de data
     diferentes: a data que vale na contraproposta é `prop_quando`, não `quando`.
     Query separada é mais longa e é a que dá pra provar lendo. */
  const [porLocal, porProp] = await Promise.all([
    sb.from('matches').select('id', { count:'exact', head:true })
      .eq('local_id', id).in('status', ['desafiado','aceito'])
      .or(`quando.gte.${limite},quando.is.null`),
    sb.from('matches').select('id', { count:'exact', head:true })
      .eq('prop_local_id', id).eq('status', 'desafiado'),
  ]);
  if(porLocal.error){ alert('Não deu pra conferir se há jogo marcado: '+porLocal.error.message); return; }
  if(porProp.error){ alert('Não deu pra conferir as contrapropostas: '+porProp.error.message); return; }

  const n = (porLocal.count||0) + (porProp.count||0);
  if(n){
    const p = n>1;
    alert(`"${l.nome}" tem ${n} jogo${p?'s':''} marcado${p?'s':''} ou proposto${p?'s':''}.\n\n`
        + `Se apagar agora, quem ia jogar fica sem o endereço e não tem como saber pra onde ir.\n\n`
        + `Desafio que você já mandou e ainda não foi respondido não dá pra cancelar por aqui — espere a pessoa aceitar ou recusar. Os que já foram aceitos você cancela na caixa de entrada.`);
    return;
  }

  /* Aviso de cortesia, não trava: `grupos.local_id` é `on delete set null`
     (mig 19) e o campo não é lido em nenhum outro lugar, então o dano é o
     rótulo da comunidade sumir e o gestor reescolher. Se a conta falhar, segue
     sem ela — travar o apagar por causa de um aviso seria pior que o aviso. */
  const gr = await sb.from('grupos').select('id', { count:'exact', head:true }).eq('local_id', id);
  const casa = (!gr.error && gr.count) ? gr.count : 0;

  if(!confirm(`Apagar "${l.nome}"?\n\n`
    + `As partidas com placar já lançado continuam valendo, com placar e rating — partida é histórico.\n\n`
    + (casa ? `${casa} comunidade${casa>1?'s':''} usa${casa>1?'m':''} essa quadra como casa e vai${casa>1?'o':''} ficar sem casa fixa.\n\n` : '')
    + `O que some é a quadra da sua lista e o endereço dela.`)) return;

  const del = await sb.from('locais').delete().eq('id', id).select('id');
  if(del.error){ alert('Não deu pra apagar: '+del.error.message); return; }
  if(!del.data || !del.data.length){ alert('Nada foi apagado — essa quadra não é sua ou já não existe.'); return; }

  netFecharLocal();
  await netLocais(true); await netMeusLocais(true);

  /* REELEGER O PRINCIPAL. `player_locais.local_id` é `on delete cascade` (mig 19),
     então se a quadra apagada era a principal, a linha some e NADA no banco
     reelege — o índice único de principal é parcial e aceita zero. O app não
     percebe porque `_locPublicar` faz `find(principal) || [0]` e publica um
     substituto SÓ EM MEMÓRIA, com estrela e tudo na tela.

     No banco a pessoa cai fora da view `player_cidade` (que filtra por
     `principal`), some do `__mapaLocais`, e aí os filtros do radar — que são
     `!m || ...` — deixam de filtrar ela: passa a aparecer no "Minha cidade" de
     TODAS as cidades. Nenhum erro, nenhuma tela quebrada, e a pessoa vazando
     pra outro estado.

     Elege o primeiro e DIZ qual foi, porque a escolha do principal era dela. */
  let extra = '';
  if(_meusLocais && _meusLocais.length && !_meusLocais.some(x=>x.principal)){
    const novo = _meusLocais[0];
    const r = await netSalvarMeusLocais(_meusLocais.map(x=>x.local_id), novo.local_id);
    const ln = _locDe(novo.local_id);
    extra = r && r.ok && ln
      ? ` <b>${_admEsc(ln.nome)}</b> virou seu principal — troque em "onde você joga" se não for esse.`
      : ' ⚠️ Você ficou sem local principal — abra "onde você joga" e marque um.';
  }
  if(window.toast) toast(`🗑 <b>${_admEsc(l.nome)}</b> apagada.${extra}`);
  if(document.getElementById('net-locais')) netAbrirMeusLocais();
}

/* ---- meus troféus (a Sala de Conquistas lê o BANCO, não só os torneios) ----
   Descoberto em 11/08 testando o ADM: a sala derivava tudo (torneios, selos
   locais) e nunca leu trofeus_temporada — Reinado, Coroa e troféu do ADM
   existiam no banco e não apareciam pra ninguém. */
/* 18/08: virou "de quem?" em vez de "meus". A ficha do outro jogador precisa
   dos troféus dele, e a policy permite: `trofeus_sel` é `for select using
   (true)` (mig 13) — troféu é fato público, quem ganhou ganhou. O `netMeusTrofeus`
   fica como atalho pra Sala de Conquistas não ter que saber disso. */
async function netTrofeusDe(uid){
  if(!uid) return [];
  const r = await sb.from('trofeus_temporada')
    .select('id,tipo,nome,etiqueta,origem,temporada,grupo_id,criado_em')
    .eq('player_id', uid).order('criado_em', {ascending:false});
  if(r.error){ console.error('[net] trofeus', r.error); return []; }
  return r.data || [];
}
async function netMeusTrofeus(){ return MEU_UID ? netTrofeusDe(MEU_UID) : []; }

/* =========================================================================
   DECLARAÇÃO DE IDADE NO LOGIN (11/08) — pras contas anteriores à migração 15.
   A mesma trava do cadastro (18 anos), no mesmo vocabulário: a data é o dado,
   a declaração é o fato histórico — guarda os dois. Menor de 18 declarado
   sai da conta na hora: a regra da abertura ("só para maiores de 18") vale
   pra conta velha igual vale pra nova.
   ========================================================================= */
/* 18/08 (mig 41): a tela de quem foi banido. Diz o que aconteceu e o que dá pra
   fazer — nada além de sair. Não tem "fale conosco" porque não existe canal;
   quando existir, entra aqui. Sem fechar clicando fora, e o único botão é sair
   da conta: banido com sessão aberta continuaria "dentro" até fechar o app. */
function netTelaBanido(row){
  const q = row.banido_em ? new Date(row.banido_em) : null;
  const p = (n)=>String(n).padStart(2,'0');
  const quando = q ? `${p(q.getDate())}/${p(q.getMonth()+1)}/${q.getFullYear()}` : '';
  const el = _sheet('net-banido', `
    <div style="font:700 17px system-ui;margin-bottom:2px">Sua conta foi suspensa</div>
    <div style="font-size:12.5px;color:var(--ink2);margin-bottom:14px;line-height:1.5">
      O ADM do Ranket suspendeu esta conta${quando?' em <b>'+quando+'</b>':''}. Enquanto estiver assim,
      o app não abre pra você — nem pra ver, nem pra jogar.
    </div>
    <div style="font-size:11.5px;color:var(--ink3);margin-bottom:16px;line-height:1.5">
      Suas partidas e seu histórico continuam guardados. Se achar que foi engano, fale com quem administra o app.
    </div>
    <button onclick="_net.sairBanido()" style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--linha2);background:none;color:#fff;font:700 14px system-ui;cursor:pointer">Sair da conta</button>`);
  el.onclick = null;
}
async function _sairBanido(){
  try{ await sb.auth.signOut(); }catch(e){}
  location.reload();
}

function netPedirIdade(){
  const el = _sheet('net-idade', `
    <div style="font:700 17px system-ui;margin-bottom:2px">Uma pergunta que faltou</div>
    <div style="font-size:12.5px;color:var(--ink2);margin-bottom:12px">Sua conta foi criada antes de o app pedir a data de nascimento. O Ranket marca jogo presencial entre pessoas que não se conhecem, então a conta é só para maiores de 18 — falta registrar o seu.</div>
    <input id="net-idade-in" type="date" max="${new Date().toISOString().slice(0,10)}"
      style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;color-scheme:dark"/>
    <div style="font-size:11px;color:var(--ink3);margin-top:6px">Ela não aparece pra ninguém — nem no seu perfil.</div>
    <button onclick="_net.idadeConfirmar()" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:14px">Confirmar</button>`);
  // sem fechar clicando fora: a pergunta não é opcional — fechar sem responder
  // deixaria a conta exatamente no estado que esta folha existe pra acabar
  el.onclick = null;
}
async function _idadeConfirmar(){
  const v = (document.getElementById('net-idade-in')||{}).value;
  const idade = window.idadeEm ? idadeEm(v, new Date()) : null;
  if(idade === null){ alert('Preencha sua data de nascimento.'); return; }
  if(idade > 120){ alert('Confira a data de nascimento.'); return; }
  if(idade < 18){
    alert('O Ranket é só para maiores de 18 anos.\n\nO app marca jogo presencial entre pessoas que não se conhecem, e por isso a conta é restrita. A gente se vê quando você fizer 18.');
    const el=document.getElementById('net-idade'); if(el) el.remove();
    if(window.sairDaConta) sairDaConta();
    return;
  }
  const agora = new Date().toISOString();
  const { error } = await sb.from('players').update({
    nascimento: v, maior_de_18: true, idade_declarada_em: agora,
  }).eq('id', MEU_UID);
  if(error){ alert('Não deu pra salvar: '+error.message); return; }
  const eu = (typeof S!=='undefined') && S.jogadores[EU];
  if(eu){ eu.nascimento=v; eu.maiorDe18=true; eu.idadeDeclaradaEm=agora; if(window.salvar) salvar(); }
  const el=document.getElementById('net-idade'); if(el) el.remove();
  if(window.toast) toast('Registrado. Obrigado!');
}

/* =========================================================================
   PATCHES (11/08) — migração 22. O desenho é o do protótipo panela-cinturão:
   até 24 caracteres, filtro de 3 camadas, preso à comunidade, envio livre
   entre membros, autoria sempre visível. Patch é identidade, não mérito —
   não exige partida. A cobrança por criação fica pra quando houver meio de
   pagamento; o modelo já separa criação de envio por isso.
   ========================================================================= */

/* Filtro de 3 camadas — roda no CLIENTE, e é cortesia (a trava do banco é o
   tamanho). Camada 1: lista dura, bloqueia. Camada 2: nome de membro da
   comunidade, bloqueia (patch apontado nominalmente é bullying com moldura).
   Camada 3: lista cinza, cria marcado pra revisão do ADM. */
const _PAT_DURA  = ['merda','bosta','caralho','porra','puta','puto','viado','buceta','cu ','fdp','arrombad','desgraça','corno','vagabund','otári','idiota','imbecil','retardad','babaca'];
// "frango" NÃO está aqui de propósito: "Rei do Frango" é o exemplo canônico do
// protótipo — zoação de quadra é a alma do patch; a cinza pega o ambíguo-hostil
const _PAT_CINZA = ['animal','burro','perna de pau','lixo','ruim de bola','pipoqueiro'];
function netPatchFiltro(texto, nomesMembros){
  const low = (texto||'').toLowerCase();
  if(!low.trim()) return { key:'vazio', ic:'', t:'', d:'' };
  if(_PAT_DURA.some(p=>low.includes(p)))
    return { key:'hard', ic:'⛔', t:'Bloqueado pela lista dura', d:'Conteúdo ofensivo: o patch não é criado nem salvo.' };
  const nomes = (nomesMembros||[]).flatMap(n=>String(n||'').toLowerCase().split(/\s+/)).filter(p=>p.length>2);
  if(nomes.some(p=>low.includes(p)))
    return { key:'target', ic:'⛔', t:'Nome de membro detectado', d:'Patch apontado nominalmente a alguém da comunidade não pode ser criado.' };
  if(_PAT_CINZA.some(p=>low.includes(p)))
    return { key:'gray', ic:'⚠️', t:'Cria marcado pra revisão', d:'Palavra ambígua: o patch nasce, mas fica sinalizado pro ADM revisar.' };
  return { key:'clear', ic:'✓', t:'Pode ser criado', d:'Não bateu em lista dura, lista cinza nem nome de membro.' };
}

/* 18/08: mesma virada dos troféus, e pela mesma razão — `patch_envios_sel` é
   `using (true)` (mig 22). Patch é elogio dado em público; esconder o de quem
   recebeu não protegeria ninguém. */
async function netPatchesDe(uid){
  if(!uid) return [];
  const es=(await sb.from('patch_envios').select('patch_id,de,criado_em').eq('para',uid)).data||[];
  if(!es.length) return [];
  const ps=(await sb.from('patches').select('id,nome,grupo_id,origem,criado_por').in('id',es.map(e=>e.patch_id))).data||[];
  const porId={}; ps.forEach(p=>porId[p.id]=p);
  return es.map(e=>({ ...e, patch:porId[e.patch_id] })).filter(x=>x.patch)
           .sort((a,b)=>(b.criado_em||'').localeCompare(a.criado_em||''));
}
async function netMeusPatches(){ return MEU_UID ? netPatchesDe(MEU_UID) : []; }

/* ---- UI: patches da comunidade (criar, mandar) ------------------------- */
let _pat=null;
async function netAbrirPatches(gid){
  const [g, ms, ps] = await Promise.all([
    sb.from('grupos').select('id,nome').eq('id',gid).maybeSingle(),
    sb.from('grupo_membros').select('player_id').eq('grupo_id',gid),
    sb.from('patches').select('id,nome,criado_por,revisao,criado_em').eq('grupo_id',gid).order('criado_em'),
  ]);
  if(!g.data){ alert('Comunidade não encontrada.'); return; }
  const ids=(ps.data||[]).map(p=>p.id);
  const envios = ids.length ? (await sb.from('patch_envios').select('patch_id,para').in('patch_id',ids)).data||[] : [];
  _pat = { gid, nome:g.data.nome, membros:(ms.data||[]).map(m=>m.player_id),
           amigos:_meusAmigos(),   // 11/08 (decisão do Nuno): patch vai pra amigo também, tipo o troféu
           patches:ps.data||[], envios, texto:'', mandando:null };
  netRenderPatches();
}
function netFecharPatches(){ _pat=null; const el=document.getElementById('net-patches'); if(el) el.remove(); }
// re-render a cada tecla porque contador e filtro respondem ao vivo (é o
// protótipo); o refoco no fim do render devolve o cursor pro fim do texto
function _patDigitou(v){ _pat.texto=v.slice(0,24); netRenderPatches(); }
function _patMandando(pid){ _pat.mandando = _pat.mandando===pid ? null : pid; netRenderPatches(); }
async function _patCriar(){
  const nome=(_pat.texto||'').trim();
  if(!nome){ alert('Escreve o texto do patch.'); return; }
  const f = netPatchFiltro(nome, _pat.membros.map(u=>_nomeDe(u)));
  if(f.key==='hard' || f.key==='target'){ alert(f.d); return; }
  const { error } = await sb.from('patches').insert({
    grupo_id:_pat.gid, nome, criado_por:MEU_UID, origem:'membro', revisao:f.key==='gray',
  });
  if(error){ alert('Não deu pra criar: '+error.message); return; }
  if(window.toast) toast(f.key==='gray' ? `◈ <b>${nome}</b> criado — marcado pra revisão.` : `◈ Patch <b>${nome}</b> criado! Agora manda pra alguém.`);
  await netAbrirPatches(_pat.gid);
}
async function _patMandar(pid, paraUid){
  const { error } = await sb.from('patch_envios').insert({ patch_id:pid, de:MEU_UID, para:paraUid });
  if(error){
    alert(/duplicate|23505/.test(error.message||error.code||'') ? `${_nomeDe(paraUid)} já tem esse patch.` : 'Não deu pra mandar: '+error.message);
    return;
  }
  if(window.toast) toast(`◈ Patch mandado pra <b>${_nomeDe(paraUid)}</b>.`);
  await netAbrirPatches(_pat.gid);
}
function netRenderPatches(){
  const f = netPatchFiltro(_pat.texto, _pat.membros.map(u=>_nomeDe(u)));
  const bloqueado = f.key==='hard'||f.key==='target';
  const corF = f.key==='clear'?'var(--up)':f.key==='gray'?'var(--gold)':'var(--dn)';
  const nEnvios=(pid)=>_pat.envios.filter(e=>e.patch_id===pid).length;
  const linhas=_pat.patches.map(p=>{
    const aberto=_pat.mandando===p.id;
    const jaTem=new Set(_pat.envios.filter(e=>e.patch_id===p.id).map(e=>e.para));
    // destino: membros da comunidade E amigos mútuos (migração 23) — etiquetados
    const ehMembro=new Set(_pat.membros);
    const alvos=[...new Set([..._pat.membros, ..._pat.amigos])].filter(u=>u!==MEU_UID && !jaTem.has(u));
    return `<div style="border:1px solid var(--linha);border-radius:13px;padding:12px;margin-top:8px">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="font-size:20px">◈</div>
        <div style="flex:1;min-width:0"><b style="font-size:14px">${p.nome}</b>${p.revisao?' <span style="color:var(--gold);font-size:10px">em revisão</span>':''}
          <div style="font-size:11px;color:var(--ink2)">por ${_nomeDe(p.criado_por)} · ${nEnvios(p.id)} envio${nEnvios(p.id)===1?'':'s'}</div></div>
        <button onclick="_net.patMandando('${p.id}')" style="padding:8px 12px;border-radius:10px;border:none;background:${aberto?'var(--sup2)':'#2C5A00'};color:#fff;font:600 12px system-ui;cursor:pointer">${aberto?'fechar':'mandar'}</button>
      </div>
      ${aberto?`<div style="margin-top:10px;border-top:1px solid var(--sup2);padding-top:8px">
        ${alvos.length?alvos.map(u=>`<button onclick="_net.patMandar('${p.id}','${u}')" style="display:block;width:100%;text-align:left;padding:9px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:600 12px system-ui;cursor:pointer;margin-top:5px">${_nomeDe(u)} <span style="font-weight:400;color:var(--ink3);font-size:10px">${ehMembro.has(u)?'da comunidade':'✔ amigo'}</span></button>`).join('')
          :'<p style="color:var(--ink2);font-size:12px;margin:4px 0 0">Comunidade e amigos — todo mundo já tem esse patch.</p>'}
      </div>`:''}
    </div>`;
  }).join('') || '<p style="color:var(--ink2);font-size:13px;margin-top:10px">Nenhum patch ainda — cria o primeiro aí embaixo.</p>';
  _sheet('net-patches', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">◈ Patches · ${_pat.nome}</div>
      <button onclick="_net.fecharPatches()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 6px">Patch é identidade, não mérito: nasce na comunidade e vai pra qualquer membro ou amigo seu — sem exigir partida. Autoria sempre visível.</div>
    ${linhas}
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--linha);font-size:12px;color:var(--ink2)">Criar um patch novo</div>
    <input id="pat-in" value="${(_pat.texto||'').replace(/"/g,'&quot;')}" oninput="_net.patDigitou(this.value)" maxlength="24" placeholder="Texto — até 24 caracteres"
      style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;margin-top:7px" autocomplete="off"/>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink3);margin-top:4px"><span>${f.key!=='vazio'?`<span style="color:${corF}">${f.ic} ${f.t}</span> — ${f.d}`:''}</span><span>${(_pat.texto||'').length}/24</span></div>
    <button onclick="_net.patCriar()" ${bloqueado||!(_pat.texto||'').trim()?'disabled style="opacity:.4;cursor:default;"':''}
      style="width:100%;padding:13px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:10px">${f.key==='gray'?'Criar e marcar pra revisão':'Criar patch'}</button>`);
  const el=document.getElementById('pat-in'); if(el && _pat.mandando===null){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); }
}

/* =========================================================================
   ADM DO APLICATIVO (11/08) — migrações 18 e 20.

   Não confundir com dono/gestor de comunidade nem com organizador de torneio:
   aqueles mandam no PRÓPRIO objeto (aceitar membro, montar chave, ligar o
   cinturão da panela deles). O ADM daqui é do app inteiro, e só existe pra
   duas coisas:

     DAR o que nenhuma regra produz — campeão de interclubes que rolou fora do
     app, quem trouxe gente, comemorativo. Esse é o uso principal.

     CONSERTAR o troféu automático quando ele sai errado. Raro, mas o troféu é
     permanente (`unique` por temporada/comunidade/tipo, sem update nem delete
     pra mais ninguém), então sem isto o erro não tem volta.

   Quem entra na lista `admins` não entra pelo app: a tabela não tem policy de
   escrita nenhuma, só se entra pelo SQL Editor. Por isso aqui não existe (e
   não pode existir) tela de "promover a ADM" — se existisse, a fechadura era
   de mentira.
   ========================================================================= */
let _adm = null;
let _admEh = null;                                   // null = ainda não perguntei

/* Chamado no boot. Guarda a resposta porque ela não muda no meio da sessão, e
   acende a porta de entrada — o card do ADM só existe no HTML se este flag
   estiver ligado (ver `__ehAdm` no index.html). Falhou a consulta? Fica não-ADM:
   o lado seguro do erro é não mostrar. */
/* 25/08 (mig 66): O PAPEL, NO BOOT.
   Antes disto o app só descobria que você é professor quando você abria a tela
   — e papel que só se conhece sob demanda não pode decidir a barra de
   navegação nem a home. Segue o molde do `netCheckAdm` logo abaixo: assíncrono,
   cacheado, e força um `render()` quando o valor chega, porque a nav depende
   dele. Falhou a consulta? Fica 'jogador': o lado seguro do erro é o app que
   já existia. */
let _perfil = null;              // null = ainda não perguntou
async function netCheckPerfil(){
  if(_perfil !== null) return _perfil;
  if(!MEU_UID){ return null; }
  try{
    const r = await sb.from('players').select('perfil, joga').eq('id', MEU_UID).maybeSingle();
    _perfil = r && r.data ? { perfil: r.data.perfil || 'jogador', joga: r.data.joga !== false }
                          : { perfil:'jogador', joga:true };
  }catch(e){ _perfil = { perfil:'jogador', joga:true }; }
  window.__perfil = _perfil;
  if(typeof render === 'function'){ try{ render(); }catch(e){} }
  return _perfil;
}
window.netCheckPerfil = netCheckPerfil;

async function netCheckAdm(){
  if(_admEh !== null) return _admEh;
  try{
    const r = await sb.from('admins').select('player_id').eq('player_id', MEU_UID).maybeSingle();
    _admEh = !!(r && r.data);
  }catch(e){ _admEh = false; }
  window.__ehAdm = _admEh;
  if(_admEh && typeof render === 'function'){ try{ render(); }catch(e){} }
  return _admEh;
}

const _admEsc = (s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function netAbrirAdm(){
  if(!(await netCheckAdm())){ if(window.toast) toast('Essa área é só do ADM.'); return; }
  _adm = _adm || { aba:'trofeus', q:'', achados:[], sel:null, trofeus:[], grupos:[],
                   novo:{ nome:'', etiqueta:'', grupo_id:'' },
                   cidades:[], locais:[], regioes:[], regNova:'',
                   loc:{ nome:'', endereco:'', cidade_id:'', regiao_id:'', tipo:'clube', quadras:1 } };
  if(!_adm.cidades.length) await _admCarregarCidades();
  netRenderAdm();
}
function netFecharAdm(){ const el=document.getElementById('net-adm'); if(el) el.remove(); }

async function _admCarregarCidades(){
  const r = await sb.from('cidades').select('id,nome,uf').order('nome');
  _adm.cidades = r.data || [];
  if(!_adm.loc.cidade_id && _adm.cidades.length) _adm.loc.cidade_id = _adm.cidades[0].id;
  await _admCarregarLocais();
}
/* Região e local vêm sempre no mesmo par: região só existe dentro de uma
   cidade, e a lista de locais é desenhada com o seletor de região em cada
   linha. Carregar um sem o outro deixaria a tela pedindo pra escolher entre
   opções que ainda não chegaram. */
async function _admCarregarLocais(){
  if(!_adm.loc.cidade_id){ _adm.locais=[]; _adm.regioes=[]; return; }
  const [ls, rs] = await Promise.all([
    // `origem` entra (15/08) porque a policy `locais_endereco_adm` só alcança
    // clube do ADM — a quadra particular de um jogador aparece na lista da
    // cidade e não pode oferecer campo de endereço que a RLS vai recusar
    sb.from('locais').select('id,nome,tipo,quadras,ativo,regiao_id,origem,locais_endereco(endereco)')
      .eq('cidade_id', _adm.loc.cidade_id).order('nome'),
    sb.from('regioes').select('id,nome').eq('cidade_id', _adm.loc.cidade_id).order('nome'),
  ]);
  /* 13/08: mesma armadilha do netLocais, e aqui é pior — no ADM a lista vazia
     vira "Nenhum local nessa cidade ainda" com o banco cheio, e como o <select>
     de região mora dentro da linha do local, some também o jeito de classificar
     clube por região. `null` distingue "não carregou" de "cidade vazia": os
     dois são o mesmo pixel hoje, e foi isso que deixou o defeito passar. */
  /* Bandeira em vez de `null`: cinco pontos leem `_adm.locais` sem guarda, e
     trocar o vazio silencioso por um crash seria piorar. A lista continua
     sendo array sempre; quem distingue "não carregou" de "cidade sem local" é
     `_adm.locaisErro`, e é o render que fala a diferença. */
  _adm.locaisErro = !!ls.error;
  if(ls.error){ console.error('[adm] locais', ls.error); _adm.locais = []; }
  else _adm.locais = ls.data.map(l=>({ ...l, endereco: _endDe(l.locais_endereco) }));
  _adm.regioes = rs.data || [];
  // trocou de cidade? a região escolhida no formulário é de outra cidade e não
  // vale mais — deixar ela lá gravaria um local em região de cidade errada.
  if(_adm.loc.regiao_id && !_adm.regioes.some(r=>r.id===_adm.loc.regiao_id)) _adm.loc.regiao_id='';
}

function _admAba(a){ _adm.aba=a; netRenderAdm(); }
function _admSet(campo, v){ _adm.novo[campo]=v; }
function _admLocSet(campo, v){
  _adm.loc[campo] = (campo==='quadras') ? Math.max(1, Math.min(60, parseInt(v||1,10)||1)) : v;
  if(campo==='cidade_id'){ _admCarregarLocais().then(netRenderAdm); return; }
  // nome e endereço são texto corrido: re-render a cada tecla perde o cursor
  if(campo!=='nome' && campo!=='endereco') netRenderAdm();
}
// mesmo motivo: texto corrido não re-renderiza a cada tecla
function _admRegSet(v){ _adm.regNova = v; }

async function _admBuscar(v){
  _adm.q = v;
  if(!v || v.trim().length < 2){ _adm.achados=[]; netRenderAdm(); return; }
  const r = await sb.from('players').select('id,nome,ap,cor,nivel').ilike('nome', '%'+v.trim()+'%').limit(12);
  _adm.achados = r.data || [];
  netRenderAdm();
}

/* Ao escolher o jogador, carrego os troféus DELE e as comunidades DELE. As
   comunidades são as dele, não todas: troféu com comunidade só faz sentido
   onde a pessoa está, e uma lista com todas as comunidades do app seria um
   campo grande onde escolher errado é fácil e permanente. */
async function _admSel(id, nome){
  _adm.sel = { id, nome };
  _adm.novo = { nome:'', etiqueta:'', grupo_id:'', patch:'', motivo:'' };
  /* 18/08 (mig 41): a moderação precisa de três leituras a mais — se está
     banido, as partidas recentes (pra anular) e o mesmo `grupos` que já vinha
     (pra tirar).

     ⚠️ A LISTA DE PARTIDAS VEM CURTA, E É A FECHADURA. `matches_select` (mig 7)
     só devolve partida em que QUEM PERGUNTA está — e o ADM raramente está.
     Aqui aparecem só as partidas do jogador contra o próprio ADM (ou de
     torneio). Pra anular qualquer partida de qualquer um, falta uma policy de
     leitura pro ADM em `matches` — mig 43. Até lá, o botão de anular existe e
     funciona (a `partida_anular` é security definer e não depende disto), mas
     só alcança o que a lista mostra. A tela DIZ isso, em vez de mostrar lista
     vazia com cara de "não tem partida". */
  const [t, g, p, m] = await Promise.all([
    sb.from('trofeus_temporada').select('id,tipo,nome,etiqueta,origem,temporada,grupo_id,criado_em')
      .eq('player_id', id).order('criado_em', {ascending:false}),
    sb.from('grupo_membros').select('grupo_id, grupos(id,nome)').eq('player_id', id),
    sb.from('players').select('banido_em,banido_por').eq('id', id).maybeSingle(),
    sb.from('matches').select('id,criador_id,adversario_id,status,placar,esporte,placar_em,created_at,anulada_em')
      .or(`criador_id.eq.${id},adversario_id.eq.${id}`)
      .in('status',['confirmada','pendente','aceito'])
      .order('created_at',{ascending:false}).limit(12),
  ]);
  _adm.trofeus  = t.data || [];
  _adm.grupos   = (g.data||[]).map(x=>x.grupos).filter(Boolean);
  _adm.banido   = !!(p.data && p.data.banido_em);
  _adm.partidas = m.data || [];
  netRenderAdm();
}

/* ---- MODERAÇÃO (18/08, mig 41) ------------------------------------------ */
async function _admBanir(ligar){
  if(!_adm.sel) return;
  const nome = _adm.sel.nome;
  if(ligar && !confirm(`Suspender a conta de ${nome}?\n\nO app para de abrir pra essa pessoa e ela some do radar e da busca. As partidas dela ficam. Dá pra desfazer.`)) return;
  if(!ligar && !confirm(`Reativar a conta de ${nome}?`)) return;
  const { error } = await sb.from('players')
    .update(ligar ? { banido_em:new Date().toISOString(), banido_por:MEU_UID } : { banido_em:null, banido_por:null })
    .eq('id', _adm.sel.id);
  if(error){ alert('Não deu: '+error.message); return; }
  if(window.toast) toast(ligar ? `⛔ Conta de ${nome} suspensa.` : `✅ Conta de ${nome} reativada.`);
  await _admSel(_adm.sel.id, nome);
}
async function _admAnular(matchId, rotulo){
  const motivo = prompt(`Anular a partida ${rotulo}?\n\nO Nível dos dois volta, os pontos são estornados e a partida fica marcada como anulada — não some.\n\nMotivo (fica registrado):`);
  if(motivo === null) return;                       // cancelou o prompt
  const { data, error } = await sb.rpc('partida_anular', { p_match: matchId, p_motivo: motivo || null });
  if(error){ alert('Não deu pra anular: '+error.message); return; }
  if(window.toast) toast(data && data.ja_estava ? 'Já estava anulada.' : `Partida anulada${data&&data.estornos?` · ${data.estornos} estorno${data.estornos>1?'s':''}`:''}.`);
  if(_adm.sel) await _admSel(_adm.sel.id, _adm.sel.nome);
}
async function _admTirarDoGrupo(gid, gnome){
  if(!_adm.sel) return;
  if(!confirm(`Tirar ${_adm.sel.nome} de "${gnome}"?`)) return;
  const { error } = await sb.from('grupo_membros').delete().eq('grupo_id', gid).eq('player_id', _adm.sel.id);
  if(error){ alert('Não deu: '+error.message); return; }
  if(window.toast) toast(`${_adm.sel.nome} saiu de ${gnome}.`);
  await _admSel(_adm.sel.id, _adm.sel.nome);
}

async function _admDar(){
  const nome = (_adm.novo.nome||'').trim();
  if(!_adm.sel){ alert('Escolhe o jogador primeiro.'); return; }
  if(!nome){ alert('O troféu precisa de um nome.'); return; }
  /* `origem:'adm'` e `criado_por` não são enfeite: a policy da migração 20
     EXIGE os dois no caminho do ADM. É o que impede um ADM de forjar troféu
     com cara de apuração automática. `tipo` guarda uma chave estável pra tela
     agrupar; o que a pessoa lê é o `nome`. */
  const linha = {
    player_id: _adm.sel.id, nome, tipo:'especial', origem:'adm', criado_por: MEU_UID,
    etiqueta: (_adm.novo.etiqueta||'').trim() || null,
    grupo_id: _adm.novo.grupo_id || null, temporada: null,
  };
  const { error } = await sb.from('trofeus_temporada').insert(linha);
  if(error){ alert('Não deu pra dar o troféu: '+error.message); return; }
  if(window.toast) toast(`🏅 Troféu entregue pra ${_adm.sel.nome}.`);
  await _admSel(_adm.sel.id, _adm.sel.nome);
}

async function _admApagar(id, rotulo){
  if(!confirm(`Apagar “${rotulo}”? Troféu não volta.`)) return;
  const { error } = await sb.from('trofeus_temporada').delete().eq('id', id);
  if(error){ alert('Não deu pra apagar: '+error.message); return; }
  if(window.toast) toast('Troféu apagado.');
  await _admSel(_adm.sel.id, _adm.sel.nome);
}

/* Mandar patch do app (pedido de 11/08, migração 22): patch com origem='adm'
   e grupo_id nulo. O molde é REUSADO por nome — "Fundador" mandado pra 10
   pessoas é um patch com 10 envios, não 10 patches: a contagem conta a
   história e a prateleira não vira estoque. */
async function _admDarPatch(){
  const nome = (_adm.novo.patch||'').trim();
  if(!_adm.sel){ alert('Escolhe o jogador primeiro.'); return; }
  if(!nome){ alert('O patch precisa de um texto (até 24 caracteres).'); return; }
  let p = (await sb.from('patches').select('id').eq('origem','adm').eq('nome',nome).maybeSingle()).data;
  if(!p){
    const r = await sb.from('patches').insert({ nome, criado_por:MEU_UID, origem:'adm', grupo_id:null }).select('id').single();
    if(r.error){ alert('Não deu pra criar o patch: '+r.error.message); return; }
    p = r.data;
  }
  const { error } = await sb.from('patch_envios').insert({ patch_id:p.id, de:MEU_UID, para:_adm.sel.id });
  if(error){
    alert(/duplicate|23505/.test(error.message||error.code||'') ? `${_adm.sel.nome} já tem esse patch.` : 'Não deu pra mandar: '+error.message);
    return;
  }
  if(window.toast) toast(`◈ Patch <b>${nome}</b> mandado pra ${_adm.sel.nome}.`);
  _adm.novo.patch='';
  await _admSel(_adm.sel.id, _adm.sel.nome);
}

async function _admSalvarLocal(){
  const nome = (_adm.loc.nome||'').trim();
  const endereco = (_adm.loc.endereco||'').trim();
  if(!nome){ alert('O clube precisa de um nome.'); return; }
  if(!_adm.loc.cidade_id){ alert('Escolhe a cidade.'); return; }
  // endereço obrigatório (11/08): o nome serve pra quem já conhece o clube;
  // quem chega pelo desafio precisa saber AONDE ir
  if(!endereco){ alert('Coloca o endereço — é ele que diz aonde ir pra quem não conhece o clube.'); return; }
  /* 13/08 (migração 25): o endereço não mora mais em `locais` — virou linha em
     `locais_endereco`, que é o que a fechadura enxerga. São duas escritas, e a
     coluna velha NÃO recebe cópia de propósito: duas casas pro mesmo fato
     divergem na primeira vez que alguém escreve numa e esquece a outra, e a
     migração 26 apaga a coluna (um insert que a mencionasse quebraria ali).
     Como não há transação pelo PostgREST, a compensação é explícita: local sem
     endereço é exatamente o estado que a tela existe pra impedir, então se a
     segunda escrita falhar o local recém-criado é desfeito. */
  const novo = await sb.from('locais').insert({
    nome, cidade_id:_adm.loc.cidade_id, tipo:_adm.loc.tipo, quadras:_adm.loc.quadras,
    // opcional de propósito: clube em cidade que ainda não tem região dividida
    // entra sem, e é classificado depois pela lista
    regiao_id: _adm.loc.regiao_id || null
  }).select('id').single();
  if(novo.error){
    const error = novo.error;
    alert(error.message.includes('duplicate') || error.code === '23505'
      ? 'Já existe um local com esse nome nessa cidade.'
      : 'Não deu pra cadastrar: '+error.message);
    return;
  }
  const end = await sb.from('locais_endereco').insert({ local_id:novo.data.id, endereco });
  if(end.error){
    const volta = await sb.from('locais').delete().eq('id', novo.data.id);
    alert('O clube foi criado mas o endereço não gravou: '+end.error.message
      + (volta.error
          ? `\n\n⚠️ E não deu pra desfazer (${volta.error.message}) — "${nome}" ficou cadastrado SEM endereço. Apaga ele na lista antes de tentar de novo.`
          : '\n\nNada foi cadastrado. Pode tentar de novo.'));
    await _admCarregarLocais(); netRenderAdm();
    return;
  }
  if(window.toast) toast(`📍 ${nome} cadastrado.`);
  _adm.loc.nome=''; _adm.loc.endereco=''; await _admCarregarLocais(); netRenderAdm();
  await netLocais(true); await netMapaLocais(true);
}

/* =========================================================================
   REGIÕES (12/08) — migração 19 criou a tabela e ela ficou sem tela.

   Região aqui é ZONA DENTRO DA CIDADE (Barra, Pituba, Itaigara), não
   macrorregião do país: é a régua que decide se dá pra jogar com alguém numa
   terça à noite, e é um dos quatro eixos da segmentação (classe × horário ×
   região × formato).

   Quem escreve é só o ADM, como cidade e local — pela mesma razão da migração
   19: texto livre vira "Barra"/"barra"/"Barra Avenida" numa semana e aí não
   filtra nada, que era a única razão de existir. E ninguém digita a própria
   região: ela deriva do clube onde a pessoa joga, exatamente como a cidade.
   ========================================================================= */
async function _admCriarRegiao(){
  const nome = (_adm.regNova||'').trim();
  if(!nome){ alert('A região precisa de um nome — ex.: Barra, Pituba, Itaigara.'); return; }
  if(!_adm.loc.cidade_id){ alert('Escolhe a cidade primeiro.'); return; }
  const { error } = await sb.from('regioes').insert({ nome, cidade_id:_adm.loc.cidade_id });
  if(error){
    alert(/duplicate|23505/.test(error.message||error.code||'')
      ? 'Já existe uma região com esse nome nessa cidade.'
      : 'Não deu pra criar a região: '+error.message);
    return;
  }
  if(window.toast) toast(`🗺️ Região ${nome} criada.`);
  _adm.regNova=''; await _admCarregarLocais(); netRenderAdm();
}

/* Apagar não é destrutivo pro local: `locais.regiao_id` é `on delete set null`
   (migração 19), então o clube fica sem região, não some. Ainda assim o aviso
   diz quantos perdem a classificação — apagar "Barra" com 6 clubes dentro
   esvazia o chip de 6 clubes de uma vez, e isso não pode ser surpresa. */
async function _admApagarRegiao(id, nome){
  const usados = _adm.locais.filter(l=>l.regiao_id===id).length;
  const aviso = usados
    ? `\n\n${usados} ${usados===1?'clube fica':'clubes ficam'} sem região (o clube não some, só perde a classificação).`
    : '';
  if(!confirm(`Apagar a região “${nome}”?${aviso}`)) return;
  const { error } = await sb.from('regioes').delete().eq('id', id);
  if(error){ alert('Não deu pra apagar: '+error.message); return; }
  if(window.toast) toast('Região apagada.');
  if(_adm.loc.regiao_id===id) _adm.loc.regiao_id='';
  await _admCarregarLocais(); netRenderAdm();
  await netLocais(true); await netMapaLocais(true);
}

/* Classificar um clube JÁ CADASTRADO. Sem isto a tela nasceria inútil: todo
   local que existe hoje entrou antes de haver região e está com `regiao_id`
   nulo — só o cadastro novo carregar região não classificaria nenhum deles. */
async function _admLocalRegiao(localId, regiaoId){
  const { error } = await sb.from('locais')
    .update({ regiao_id: regiaoId || null }).eq('id', localId);
  if(error){ alert('Não deu pra mudar a região: '+error.message); return; }
  const l = _adm.locais.find(x=>x.id===localId); if(l) l.regiao_id = regiaoId || null;
  const r = _adm.regioes.find(x=>x.id===regiaoId);
  if(window.toast) toast(r ? `📍 ${l?l.nome:'Local'} → ${r.nome}.` : `📍 ${l?l.nome:'Local'} ficou sem região.`);
  netRenderAdm();
  /* O cache de locais do app inteiro (`_locais`) e o mapa do radar guardam a
     região. Sem recarregar, o chip do radar segue com o valor velho até o
     próximo boot — e o ADM ia jurar que não funcionou. */
  await netLocais(true); await netMapaLocais(true);
}

/* Endereço de clube JÁ CADASTRADO (15/08). Mesma lacuna que a região tinha: o
   `_admSalvarLocal` só grava endereço no CADASTRO, então clube que entrou antes
   de 11/08 — quando o campo virou obrigatório — ficou sem endereço e sem
   nenhuma tela pra ganhar um. Consertar por SQL na mão resolvia uma vez e
   deixava a próxima igual.

   `upsert` e não `insert`: o clube pode nunca ter tido linha em
   `locais_endereco` (nasceu sem) ou já ter uma (está corrigindo). `local_id` é
   a PK, então o onConflict resolve os dois casos num caminho só — e um caminho
   só é o que impede as duas casas do mesmo fato divergirem.

   Vazio é recusado em vez de apagar a linha: endereço em branco é exatamente o
   estado que a tela de cadastro existe pra impedir, e "quem chega pelo desafio
   precisa saber aonde ir" não fica menos verdade na edição. */
async function _admSalvarEndereco(localId, valor){
  const l = _adm.locais.find(x=>x.id===localId); if(!l) return;
  const endereco = (valor||'').trim();
  if(endereco === (l.endereco||'')) return;          // não gasta escrita à toa
  if(!endereco){
    alert('O endereço não pode ficar vazio — é ele que diz aonde ir pra quem não conhece o clube.');
    netRenderAdm();                                   // devolve o valor antigo ao campo
    return;
  }
  const { error } = await sb.from('locais_endereco')
    .upsert({ local_id: localId, endereco }, { onConflict: 'local_id' });
  if(error){ alert('Não deu pra gravar o endereço: '+error.message); netRenderAdm(); return; }
  l.endereco = endereco;
  if(window.toast) toast(`📍 Endereço de ${l.nome} atualizado.`);
  netRenderAdm();
  // o app inteiro guarda o endereço no cache de locais; sem recarregar, o card
  // da partida segue mostrando o velho até o próximo boot
  await netLocais(true); await netMapaLocais(true);
}

function netRenderAdm(){
  const abaBtn=(id,txt)=>`<button onclick="_net.admAba('${id}')" style="flex:1;padding:10px;border-radius:10px;
    border:1px solid var(--linha2);font:600 13px system-ui;cursor:pointer;
    background:${_adm.aba===id?'var(--up-bg)':'var(--sup2)'};color:${_adm.aba===id?'var(--up)':'#fff'}">${txt}</button>`;

  let corpo='';

  if(_adm.aba==='trofeus'){
    const achados = _adm.achados.map(p=>`
      <div onclick="_net.admSel('${p.id}','${_admEsc((p.nome||'').replace(/'/g,'’'))}')"
        style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--linha);border-radius:11px;margin-top:7px;cursor:pointer">
        ${_disco(p, 32)}
        <div style="flex:1;min-width:0"><b>${_admEsc(p.nome)}</b>
          <div style="font-size:11px;color:var(--ink2)">Nível ${p.nivel}</div></div>
        <div style="color:var(--ink3)">›</div></div>`).join('');

    let painel='';
    if(_adm.sel){
      const lista = _adm.trofeus.map(t=>{
        const rotulo = t.nome || (t.tipo==='reinado'?'Reinado':t.tipo==='coroa'?'Coroa':t.tipo);
        const auto = t.origem!=='adm';
        return `<div style="display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--linha);border-radius:11px;margin-top:7px">
          <div style="flex:1;min-width:0">
            <b>${_admEsc(rotulo)}</b>
            <span style="font-size:10px;padding:2px 6px;border-radius:5px;margin-left:6px;
              background:${auto?'var(--sup2)':'var(--gold-bg)'};color:${auto?'var(--ink3)':'var(--gold)'}">${auto?'automático':'dado por você'}</span>
            <div style="font-size:11px;color:var(--ink2)">${_admEsc(t.etiqueta||'—')}${t.temporada?` · temporada ${t.temporada}`:''}</div>
          </div>
          <button onclick="_net.admApagar('${t.id}','${_admEsc(rotulo.replace(/'/g,'’'))}')"
            style="padding:7px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--dn-bg);color:#fff;font:600 12px system-ui;cursor:pointer">Apagar</button>
        </div>`;
      }).join('') || `<p style="color:var(--ink2);font-size:12px;margin-top:8px">Nenhum troféu ainda.</p>`;

      const ops = ['<option value="">Sem comunidade</option>']
        .concat(_adm.grupos.map(g=>`<option value="${g.id}"${_adm.novo.grupo_id===g.id?' selected':''}>${_admEsc(g.nome)}</option>`)).join('');

      painel = `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--linha)">
          <div style="font:700 15px system-ui">${_admEsc(_adm.sel.nome)}</div>
          ${lista}
          <div style="margin-top:16px;font-size:12px;color:var(--ink2)">Dar um troféu novo</div>
          <input id="adm-tn" value="${_admEsc(_adm.novo.nome)}" oninput="_net.admSet('nome',this.value)"
            placeholder="Nome do troféu (ex.: Campeão Interclubes 2026)"
            style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:7px" autocomplete="off"/>
          <input value="${_admEsc(_adm.novo.etiqueta)}" oninput="_net.admSet('etiqueta',this.value)"
            placeholder="Linha de baixo (opcional) — ex.: Clube Bahiano · 32 jogadores"
            style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui;margin-top:7px" autocomplete="off"/>
          <select onchange="_net.admSet('grupo_id',this.value)"
            style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui;margin-top:7px">${ops}</select>
          <button onclick="_net.admDar()" style="width:100%;padding:13px;border-radius:12px;border:none;background:var(--up-bg);color:var(--up);font:700 14px system-ui;cursor:pointer;margin-top:11px">🏅 Entregar troféu</button>
          <div style="margin-top:16px;font-size:12px;color:var(--ink2)">Mandar um patch do app <span style="color:var(--ink3)">(reusa o molde se o texto já existir)</span></div>
          <input value="${_admEsc(_adm.novo.patch||'')}" oninput="_net.admSet('patch',this.value)" maxlength="24"
            placeholder="Texto do patch — até 24 (ex.: Fundador)"
            style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:7px" autocomplete="off"/>
          <button onclick="_net.admDarPatch()" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:700 13px system-ui;cursor:pointer;margin-top:8px">◈ Mandar patch</button>

          <!-- 18/08 (mig 41): MODERAÇÃO. Vem por ÚLTIMO e separada por uma
               linha porque é a parte do painel que faz mal — troféu e patch
               dão; isto tira. Ordem na tela = ordem de gravidade. -->
          <div style="margin-top:22px;padding-top:14px;border-top:1px dashed var(--dn-bg)">
            <div style="font:700 11px system-ui;color:var(--dn);text-transform:uppercase;letter-spacing:.08em">Moderação</div>

            ${_adm.banido
              ? `<div style="margin-top:9px;padding:10px 12px;border-radius:11px;background:var(--dn-bg);font-size:12.5px"><b>⛔ Conta suspensa.</b> O app não abre pra ${_admEsc(_adm.sel.nome)} e ela não aparece no radar nem na busca.</div>
                 <button onclick="_net.admBanir(false)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:700 13px system-ui;cursor:pointer;margin-top:8px">Reativar a conta</button>`
              : `<button onclick="_net.admBanir(true)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--dn-bg);background:none;color:var(--dn);font:700 13px system-ui;cursor:pointer;margin-top:9px">⛔ Suspender a conta</button>
                 <div style="font-size:10.5px;color:var(--ink3);margin-top:5px">Some do radar e da busca; o app para de abrir. As partidas ficam. Dá pra desfazer.</div>`}

            <div style="margin-top:16px;font-size:12px;color:var(--ink2)">Anular partida <span style="color:var(--ink3)">(volta Nível e estorna pontos — não apaga)</span></div>
            ${(_adm.partidas||[]).filter(m=>!m.anulada_em).map(m=>{
                const outro = m.criador_id===_adm.sel.id ? m.adversario_id : m.criador_id;
                const q = m.placar_em||m.created_at, d=new Date(q), pp=(n)=>String(n).padStart(2,'0');
                const rot = `${pp(d.getDate())}/${pp(d.getMonth()+1)} · vs ${_nomeDe(outro).split(' ')[0]}${m.placar?' · '+m.placar:''}`;
                return `<div style="display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid var(--linha);border-radius:11px;margin-top:6px">
                  <div style="flex:1;min-width:0;font-size:12px"><b>${_admEsc(rot)}</b>
                    <div style="font-size:10.5px;color:var(--ink3)">${m.status}${m.esporte==='beach'?' · beach':''}</div></div>
                  <button onclick="_net.admAnular('${m.id}','${_admEsc(rot.replace(/'/g,'’'))}')"
                    style="padding:7px 10px;border-radius:9px;border:1px solid var(--dn-bg);background:none;color:var(--dn);font:600 11px system-ui;cursor:pointer">Anular</button>
                </div>`;
              }).join('')
              || `<p style="color:var(--ink3);font-size:11.5px;margin-top:6px;line-height:1.45">Nenhuma partida visível. Por enquanto só aparecem as partidas dessa pessoa <b>contra você</b> ou de torneio — a fechadura de leitura de partidas não abre pro ADM ainda (mig 43).</p>`}

            <div style="margin-top:16px;font-size:12px;color:var(--ink2)">Tirar de comunidade</div>
            ${_adm.grupos.map(g=>`<div style="display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid var(--linha);border-radius:11px;margin-top:6px">
                <div style="flex:1;min-width:0;font-size:12.5px"><b>${_admEsc(g.nome)}</b></div>
                <button onclick="_net.admTirarDoGrupo('${g.id}','${_admEsc((g.nome||'').replace(/'/g,'’'))}')"
                  style="padding:7px 10px;border-radius:9px;border:1px solid var(--dn-bg);background:none;color:var(--dn);font:600 11px system-ui;cursor:pointer">Tirar</button>
              </div>`).join('')
              || `<p style="color:var(--ink3);font-size:11.5px;margin-top:6px">Não está em nenhuma comunidade.</p>`}
          </div>
        </div>`;
    }

    corpo = `
      <input id="adm-q" value="${_admEsc(_adm.q)}" oninput="_net.admBuscar(this.value)" placeholder="Buscar jogador por nome"
        style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;margin-top:12px" autocomplete="off"/>
      ${achados}${painel}`;

  } else {
    const cid = _adm.cidades.map(c=>`<option value="${c.id}"${_adm.loc.cidade_id===c.id?' selected':''}>${_admEsc(c.nome)}/${_admEsc(c.uf)}</option>`).join('')
      || '<option value="">Nenhuma cidade — rode a migração 19</option>';
    const seg = [['clube','Clube'],['condominio','Condomínio'],['publico','Público'],['academia','Academia']]
      .map(([v,n])=>`<button onclick="_net.admLocSet('tipo','${v}')" style="flex:1;padding:9px;border-radius:9px;border:1px solid var(--linha2);font:600 12px system-ui;cursor:pointer;background:${_adm.loc.tipo===v?'var(--up-bg)':'var(--sup2)'};color:${_adm.loc.tipo===v?'var(--up)':'#fff'}">${n}</button>`).join('');
    /* Opções de região, reusadas no formulário e em cada linha da lista. O
       `sel` chega de fora porque cada linha tem a sua região marcada. */
    const regOps = (sel)=>['<option value="">Sem região</option>']
      .concat(_adm.regioes.map(r=>`<option value="${r.id}"${sel===r.id?' selected':''}>${_admEsc(r.nome)}</option>`)).join('');

    /* As regiões da cidade. Ficam ACIMA da lista de locais de propósito: é aqui
       que se cria a opção que a linha de baixo vai oferecer, e a ordem na tela
       é a ordem do trabalho (dividir a cidade → classificar os clubes). */
    const chipsReg = _adm.regioes.map(r=>{
      const n = _adm.locais.filter(l=>l.regiao_id===r.id).length;
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--linha);border-radius:10px;margin-top:6px">
        <div style="flex:1;min-width:0"><b style="font-size:13px">${_admEsc(r.nome)}</b>
          <span style="font-size:11px;color:var(--ink2)"> · ${n} ${n===1?'clube':'clubes'}</span></div>
        <button onclick="_net.admApagarRegiao('${r.id}','${_admEsc(r.nome.replace(/'/g,'’'))}')"
          style="padding:6px 9px;border-radius:8px;border:1px solid var(--linha2);background:var(--dn-bg);color:#fff;font:600 11px system-ui;cursor:pointer">Apagar</button>
      </div>`;
    }).join('') || `<p style="color:var(--ink2);font-size:12px;margin-top:6px">Nenhuma região ainda. Enquanto não houver, o radar dessa cidade só filtra por clube.</p>`;

    const jaTem = _adm.locais.map(l=>`
      <div style="padding:9px 10px;border:1px solid var(--linha);border-radius:11px;margin-top:6px">
        <b>${_admEsc(l.nome)}</b>${l.origem!=='adm'?' <span style="font-size:10px;color:var(--ink3);font-weight:400">· quadra particular</span>':''}
        <div style="font-size:11px;color:var(--ink2)">${_admEsc(l.tipo)} · ${l.quadras} ${l.quadras===1?'quadra':'quadras'}</div>
        ${l.origem==='adm' ? `
        <!-- 15/08: endereço editável. Só pra clube do ADM — a policy
             locais_endereco_adm não alcança quadra particular, e campo que a
             RLS vai recusar é erro esperando a pessoa chegar. A borda dourada
             marca quem está SEM endereço: é o estado que a regra "quem chega
             pelo desafio precisa saber aonde ir" existe pra não deixar passar,
             e sem marcação ele se esconde numa lista longa. -->
        <input value="${_admEsc(l.endereco||'')}" placeholder="Endereço — aonde ir pra quem não conhece"
          onchange="_net.admSalvarEndereco('${l.id}', this.value)"
          style="width:100%;padding:8px;border-radius:9px;border:1px solid ${l.endereco?'var(--linha2)':'var(--gold-bg)'};background:var(--bg);color:${l.endereco?'#fff':'var(--gold)'};font:600 12px system-ui;margin-top:7px">`
        : `<div style="font-size:11px;color:var(--ink3);margin-top:7px">📍 endereço protegido — só o dono edita</div>`}
        <select onchange="_net.admLocalRegiao('${l.id}',this.value)"
          style="width:100%;padding:8px;border-radius:9px;border:1px solid ${l.regiao_id?'var(--linha2)':'var(--gold-bg)'};background:var(--bg);color:${l.regiao_id?'#fff':'var(--gold)'};font:600 12px system-ui;margin-top:7px">${regOps(l.regiao_id)}</select>
      </div>`).join('')
      /* 13/08: "não carregou" e "cidade vazia" eram o mesmo pixel, e é assim
         que um erro de consulta se disfarça de estado legítimo. */
      || (_adm.locaisErro
        ? `<p style="color:var(--dn);font-size:12px;margin-top:8px">Não deu pra carregar os locais. Veja o console e tente de novo — <b>isto não quer dizer que a cidade está vazia</b>.</p>`
        : `<p style="color:var(--ink2);font-size:12px;margin-top:8px">Nenhum local nessa cidade ainda.</p>`);

    const semReg = _adm.locais.filter(l=>!l.regiao_id).length;

    corpo = `
      <div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Cidade</div>
      <select onchange="_net.admLocSet('cidade_id',this.value)"
        style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">${cid}</select>

      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--linha);font-size:12px;color:var(--ink2)">Regiões dessa cidade <span style="color:var(--ink3)">— zona dentro da cidade (Barra, Pituba), não macrorregião</span></div>
      ${chipsReg}
      <div style="display:flex;gap:6px;margin-top:8px">
        <input id="adm-rn" value="${_admEsc(_adm.regNova||'')}" oninput="_net.admRegSet(this.value)" placeholder="Nome da região — ex.: Barra"
          style="flex:1;min-width:0;padding:11px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui" autocomplete="off"/>
        <button onclick="_net.admCriarRegiao()" style="padding:11px 14px;border-radius:11px;border:none;background:var(--up-bg);color:var(--up);font:700 13px system-ui;cursor:pointer;white-space:nowrap">+ Criar</button>
      </div>

      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--linha);font-size:12px;color:var(--ink2)">Locais dessa cidade${semReg?` <span style="color:var(--gold)">— ${semReg} sem região</span>`:''}</div>
      ${jaTem}
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--linha);font-size:12px;color:var(--ink2)">Cadastrar um local novo</div>
      <input id="adm-ln" value="${_admEsc(_adm.loc.nome)}" oninput="_net.admLocSet('nome',this.value)" placeholder="Nome do clube"
        style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:7px" autocomplete="off"/>
      <input id="adm-le" value="${_admEsc(_adm.loc.endereco||'')}" oninput="_net.admLocSet('endereco',this.value)" placeholder="Endereço — ex.: Av. Sete de Setembro, 3222 — Barra"
        style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui;margin-top:8px" autocomplete="off"/>
      <div style="display:flex;gap:6px;margin-top:8px">${seg}</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
        <div style="font-size:12px;color:var(--ink2);flex:1">Quantas quadras</div>
        <input type="number" min="1" max="60" value="${_adm.loc.quadras}" oninput="_net.admLocSet('quadras',this.value)"
          style="width:84px;padding:10px;border-radius:10px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;text-align:center"/>
      </div>
      <select onchange="_net.admLocSet('regiao_id',this.value)"
        style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 13px system-ui;margin-top:8px">${regOps(_adm.loc.regiao_id)}</select>
      <button onclick="_net.admSalvarLocal()" style="width:100%;padding:13px;border-radius:12px;border:none;background:var(--up-bg);color:var(--up);font:700 14px system-ui;cursor:pointer;margin-top:12px">📍 Cadastrar local</button>`;
  }

  _sheet('net-adm', `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font:700 17px system-ui">ADM do aplicativo</div>
      <button onclick="_net.fecharAdm()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="display:flex;gap:7px">${abaBtn('trofeus','🏅 Troféus')}${abaBtn('locais','📍 Locais')}</div>
    ${corpo}`);

  // devolve o cursor pro campo em que se estava digitando (o painel re-renderiza inteiro)
  const foco = _adm.aba==='trofeus'
    ? (_adm.sel && _adm.novo.nome!=='' ? 'adm-tn' : 'adm-q')
    : (_adm.regNova ? 'adm-rn' : _adm.loc.nome!=='' ? 'adm-ln' : null);
  if(foco){ const el=document.getElementById(foco); if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
}
window.netAbrirAdm = netAbrirAdm;

// exposto pro app e pros onclick
window.netAbrirTorneios = netAbrirTorneios;
window._net = { sb, netEntrar, netSyncJogador, netAdversarios, netBoot, uid:()=>MEU_UID,
  desafiar:netDesafiar, confirmarDesafio:_onConfirmarDesafio, aceitar:netAceitar, recusar:netRecusar,
  /* mig 45/46 — duplas. Mesma advertência do bloco abaixo: o `onclick` só
     enxerga o que está neste mapa. */
  aceitarParceiro:netAceitarParceiro, onDupla:_onDupla, onParceiro:_onParceiro,
  /* mig 25 — presença e contraproposta. Os cinco entram AQUI e não em outro
     lugar: o `onclick` do HTML só enxerga o que está neste mapa, e função que
     fica de fora morre em silêncio (foi o que aconteceu com `onQuando`). */
  checkin:netCheckin, aceitarContra:netAceitarContra,
  abrirContra:netAbrirContra, enviarContra:_onEnviarContra,
  onQuadraPor:_onQuadraPor, onBolaPor:_onBolaPor,
  lancar:netLancarPlacar, digitou:_onDigitou, enviar:_onEnviar, confirmar:netConfirmar, contestar:netContestar,
  addSet:_addSet, tiraSet:_tiraSet,   // 16/08: placares prontos
  verJogador:netVerJogador, fecharPerfil:netFecharPerfil, pedirAmizade:netPedirAmizade,  // 16/08: perfil no radar
  abrirInbox:netAbrirInbox, fecharInbox:netFecharInbox, fechar:netFecharOnline,
  abrirBusca:netAbrirBusca, fecharBusca:netFecharBusca, buscar:_onBuscar, addAmigo:netAddAmigo, desafiarUid:netDesafiarUid,
  aceitarAmizade:netAceitarAmizade, recusarAmizade:netRecusarAmizade,
  abrirTorneios:netAbrirTorneios, fecharTorneios:netFecharTorneios, criarTorneio:netCriarTorneioUI, fecharTnew:netFecharTnew,
  tset:_tset, tcriar:_tcriar, verTorneio:netVerTorneio, fecharTver:netFecharTver, entrarTorneio:netEntrarTorneio, sairTorneio:netSairTorneio,
  tclasse:_tclasse, tcatadd:_tcatadd, tcatdel:_tcatdel, tcatset:_tcatset, tcatclasse:_tcatclasse,
  abrirGrupos:netAbrirGrupos, fecharGrupos:netFecharGrupos, criarGrupo:netCriarGrupoUI, fecharGnew:netFecharGnew, gset:_gset, gcriar:_gcriar,
  verGrupo:netVerGrupo, fecharGver:netFecharGver, pedirEntrar:netPedirEntrar, aceitarPedido:netAceitarPedido, recusarPedido:netRecusarPedido,
  mudarPapel:netMudarPapel, removerMembro:netRemoverMembro, sairGrupo:netSairGrupo, copiarLinkGrupo:netCopiarLinkGrupo, revogarLink:netRevogarLink, trocarConta:netTrocarConta,
  ligarCinturao:netLigarCinturao,
  copiarLinkTorneio:netCopiarLinkTorneio, editarTorneio:netEditarTorneio, montarChave:netMontarChave, torneioPlacar:netTorneioPlacar,
  torneioPlacarOrg:netTorneioPlacarOrg, orgEnviar:_onEnviarOrg, meusCampeonatos:netMeusCampeonatos,
  buscarGrupos:netBuscarGrupos, convidarAmigo:netConvidarAmigo,
  abrirLogin:netAbrirLogin, enviarLogin:netEnviarLogin,
  esqueciSenha:netEsqueciSenha, salvarNovaSenha:netSalvarNovaSenha, olhoSenha:netOlhoSenha,
  abrirAdm:netAbrirAdm, fecharAdm:netFecharAdm, admAba:_admAba, admBuscar:_admBuscar,
  admSel:_admSel, admSet:_admSet, admDar:_admDar, admApagar:_admApagar,
  admBanir:_admBanir, admAnular:_admAnular, admTirarDoGrupo:_admTirarDoGrupo,   // 18/08 (mig 41)
  admLocSet:_admLocSet, admSalvarLocal:_admSalvarLocal,
  admRegSet:_admRegSet, admCriarRegiao:_admCriarRegiao, admApagarRegiao:_admApagarRegiao,
  admLocalRegiao:_admLocalRegiao, admSalvarEndereco:_admSalvarEndereco,
  meusQuadros:netMeusQuadros, quadrosDaPartida:netQuadrosDaPartida, destaques:netDestaques,
  locais:netLocais, meusLocais:netMeusLocais, salvarMeusLocais:netSalvarMeusLocais,
  abrirLocais:netAbrirMeusLocais, fecharLocais:netFecharMeusLocais,
  locToggle:_locToggle, locPrincipal:_locPrincipal, locSalvar:_locSalvar,
  /* 25/08: o radar precisa do NOME do lugar a partir do id — a view
     `player_cidade` (mig 19) devolve só `local_id`, então o card lia um campo
     `local_nome` que nunca existiu e o pin nascia vazio em silêncio. */
  locNome:_locNome, locDe:_locDe,
  // 18/08: perfil do clube (30) e cadastro de quadra particular (31)
  verLocal:netVerLocal, fecharLocal:netFecharLocal,
  criarQuadra:netCriarQuadra, fecharQnova:netFecharQnova, qset:_qset, qsalvar:_qsalvar,
  editarQuadra:netEditarQuadra, apagarQuadra:netApagarQuadra,
  // 18/08: a conversa da comunidade (mig 37) e da partida (mig 40) — mesma folha
  abrirChat:netAbrirChat, abrirChatPartida:netAbrirChatPartida, fecharChat:netFecharChat,
  chatHub:netChatHub,
  agenda:netAgenda,
  adsEvento:netAdsEvento, adsRelatorio:netAdsRelatorio,
  checkPerfil:netCheckPerfil,
  aulas:netAulas, aulaCriar:netAulaCriar, aulaDesligar:netAulaDesligar,
  aulaAluno:netAulaAluno, aulaCancelar:netAulaCancelar, aulaDescancelar:netAulaDescancelar,
  turmaCriar:netTurmaCriar, alunosDetalhe:netAlunosDetalhe,
  professores:netProfessores, meuProfessor:netMeuProfessor, salvarProfessor:netSalvarProfessor,
  turma:netTurma, alunoPedir:netAlunoPedir, alunoAceitar:netAlunoAceitar,
  alunoRecusar:netAlunoRecusar, alunoEncerrar:netAlunoEncerrar,
  salvarLugar:netSalvarLugar, criarTorneioExterno:netCriarTorneioExterno, cidades:netCidades,
  fbResponder:netFeedbackResponder, fbAbrir:_fbAbrir,
  dispMinhas:netDispMinhas, dispTodas:netDispTodas, dispCriar:netDispCriar, dispApagar:netDispApagar,
  conviteValidar:netConviteValidar, conviteConsumir:netConviteConsumir, conviteGerar:netConviteGerar,
  meusConvites:netMeusConvites, interessado:netInteressado,
  chatEnviar:_chatEnviar, chatDigitou:_chatDigitou, chatApagar:_chatApagar,
  /* 13/08: `onQuando` ficou de fora quando o campo de data entrou (mig 21) e os
     irmãos dela — `onLocal` e `onQuadra` — foram exportados. A função existia,
     só não estava no `_net`, então o `onchange` do datetime-local morria em
     silêncio nas DUAS folhas que o usam (desafiar e lançar na mão): o horário
     escolhido nunca chegava em `_on.quando` e a partida saía sem hora. */
  onLocal:_onLocal, onQuadra:_onQuadra, onQuando:_onQuando, onQuandoAtalho:_onQuandoAtalho,
  cancelarDesafio:netCancelarDesafio,
  gcasa:netDefinirCasa, meusTrofeus:netMeusTrofeus, meusGrupos:netMeusGrupos,
  abrirPatches:netAbrirPatches, fecharPatches:netFecharPatches, patDigitou:_patDigitou,
  patMandando:_patMandando, patCriar:_patCriar, patMandar:_patMandar,
  admDarPatch:_admDarPatch, meusPatches:netMeusPatches,
  pedirIdade:netPedirIdade, idadeConfirmar:_idadeConfirmar,
  sairBanido:_sairBanido,   // 18/08 (mig 41)
  abrirMao:netAbrirMao, maoAdv:_maoAdv, maoFmt:_maoFmt, maoEnviar:_maoEnviar };
window.netAbrirMeusLocais = netAbrirMeusLocais;
window.netAbrirInbox = netAbrirInbox;
