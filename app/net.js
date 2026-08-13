/* =========================================================================
   net.js — camada de conexão com o Supabase (v1 do teste ponta a ponta)
   O motor de cálculo continua no cliente; aqui só cuidamos de:
     1. entrar (login anônimo — sem digitar nada)
     2. espelhar o MEU jogador no banco (upsert)
     3. listar adversários reais (outros aparelhos que abriram o app)
   Passos 4 e 5 (mandar partida, receber+confirmar) entram depois, aqui mesmo.
   A chave abaixo é a "publishable" — pública por design, pode ficar no cliente.
   ========================================================================= */
const SB_URL = 'https://ogeeholzwptvyjfqpwfi.supabase.co';
const SB_KEY = 'sb_publishable_EVVNXZHCHd2c8bKr1IC7uw_OTwijVNY';

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
    nivel: eu.nivel ?? 1200, nivelb: eu.nivelB ?? 1200,
    calibrando: !!eu.calibrando, cal: eu.cal ?? 0,
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
  };
  const { error } = await sb.from('players').upsert(row);
  if(error){ console.error('[net] sync falhou', error); throw error; }
}

/* 3. Adversários reais: todo mundo no banco menos eu. Vira a lista do
      "escolher adversário" da partida online. */
async function netAdversarios(){
  if(!MEU_UID) return [];
  const { data, error } = await sb.from('players')
    .select('id, nome, ap, nivel, nivelb, bon, cor')
    .neq('id', MEU_UID)
    .order('nome');
  if(error){ console.error('[net] lista falhou', error); return []; }
  return data;
}

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
    // liga o tempo-real e carrega as partidas em aberto (desafios, placares pra confirmar)
    netSubscribe();
    await netAtualizarInbox();
    try{ await netEntrarPorLink(); }catch(e){ console.error('[net] entrar por link', e); }
    // virada da temporada: apura troféus e abre a próxima, se a atual venceu
    try{ await netFecharTemporada(); }catch(e){}
    // sou ADM do app? acende a porta de entrada da aba ADM (migração 18)
    try{ await netCheckAdm(); }catch(e){}
    // localização (migração 19): locais + os meus + o mapa do radar. O espelho
    // em window é o que as telas síncronas leem (ficha, quadro, radar).
    try{ await netLocais(); await netMeusLocais(); await netMapaLocais(); }catch(e){}
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
async function netPedirAmizade(uid){
  if(!MEU_UID || uid === MEU_UID) return;
  const { error } = await sb.from('amizade_pedidos')
    .upsert({ de: MEU_UID, para: uid, estado: 'pendente' }, { onConflict: 'de,para' });
  if(error){
    console.error('[net] pedir amizade', error);
    if(window.toast) toast('Não deu pra enviar o pedido agora. Tente de novo.');
    return;                      // não mexe no estado local se o banco recusou
  }
  /* NÃO entra em `_meusAmigos()`: a amizade não existe ainda, e escrever aqui
     faria a tela afirmar o que não aconteceu — a mesma armadilha do toast que
     confirma o que não persistiu. */
  if(window.render) render();
  if(window.netRenderBusca) netRenderBusca();
  if(window.toast) toast('Pedido enviado. Vocês viram amigos quando <b>'
    + _nomeDe(uid).split(' ')[0] + '</b> aceitar.');
}
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
  const { data } = await sb.from('players').select('id,nome,ap,email,nivel,nivelb,bon,cor').neq('id',MEU_UID);
  const idHex = termo.replace(/[^a-f0-9]/g,'');
  return (data||[]).filter(p=>
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
const _expirando = {};   // guarda de reentrada do vencimento do cinturão
let _inboxStatus = {};   // matchId → último status visto (detecta transições novas)

function netSubscribe(){
  if(_canal || !MEU_UID) return;
  _canal = sb.channel('matches-'+MEU_UID)
    .on('postgres_changes', { event:'*', schema:'public', table:'matches' }, ()=> netAtualizarInbox())
    .subscribe();
}

// precisa da MINHA ação?  (desafio pra mim · aceito sem placar · placar pra confirmar)
function netAcionavel(m){
  if(m.status==='desafiado') return m.adversario_id===MEU_UID;
  if(m.status==='aceito')    return true;                    // qualquer um dos dois lança
  if(m.status==='pendente')  return m.placar_por !== MEU_UID; // o outro confirma
  return false;
}

async function netAtualizarInbox(){
  if(!MEU_UID) return;
  const { data, error } = await sb.from('matches').select('*')
    .or(`criador_id.eq.${MEU_UID},adversario_id.eq.${MEU_UID}`)
    .in('status',['desafiado','aceito','pendente','confirmada'])
    .order('created_at',{ascending:false});
  if(error){ console.error('[net] inbox', error); return; }
  // 11/08: apura o prazo de 72h ANTES de ler o resto. Se fechou alguma, a
  // lista em mãos envelheceu na hora — recarrega em vez de renderizar dado
  // morto. Não recursa infinito: partida fechada sai de 'pendente' e o
  // `_prazoVencido` para de vê-la na segunda passada.
  if(await netApurarPrazos(data)) return netAtualizarInbox();
  // se apareceu alguém que ainda não está no meu elenco (desafiou recém-cadastrado),
  // recarrega os jogadores pra o nome aparecer certo em vez de "Jogador".
  const desconhecido = data.some(m=> !S.jogadores[_chaveLocal(_advId(m))]);
  if(desconhecido && window.aplicarJogadoresReais){
    try{ window.aplicarJogadoresReais(await netAdversarios()); }catch(e){}
  }
  netAplicarConfirmadas(data);                 // mexe no meu nível se fechou partida
  let abrirInbox=false, desafioVS=null;
  data.forEach(m=>{
    const prev=_inboxStatus[m.id];
    if(netAcionavel(m) && prev!==m.status){          // transição nova que exige ação
      if(m.status==='desafiado' && m.adversario_id===MEU_UID) desafioVS=m;   // desafio → tela VS
      else abrirInbox=true;                                                   // resto → caixa
    }
    _inboxStatus[m.id]=m.status;
  });
  _inbox = data.filter(m=> m.status!=='confirmada' && m.status!=='recusado');
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
    const meu = _souCriador(m) ? m.delta_criador : m.delta_adversario;
    const eu = S.jogadores[EU];
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
    S.historico.unshift({ adv:_advId(m), venceu:euVenci, placar:meuPlacar,
      dnivel:meu.dNivel||0, dpts:meu.dPts||0, quando:'agora',
      porPrazo: !!m.fechada_por_prazo });
    S.deltasAplicados.push(m.id); mexeu=true;
    ultima = { m, meu, euVenci, meuPlacar };
    const nome0 = _nomeDe(_advId(m)).split(' ')[0];
    if(window.toast){
      toast(m.fechada_por_prazo
        ? `${nome0} não confirmou em 72h — o placar fechou sozinho valendo <b>metade</b> · Nível ${(meu.dNivel>=0?'+':'')}${meu.dNivel}`
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
    S.ultimo = {
      adv: _chaveLocal(_advId(m)), venceu: euVenci, placar: meuPlacar,
      contexto: _ctxDoTorneio(await _torneioDe(m.torneio_id)),
      zebra: !!meu.zebra, dNivel: dN, dPts: meu.dPts || 0,
      nivel: nivelDepois, div: divDepois,
      posAntes, posDepois,
      subiuDiv: divAntes !== divDepois && dN > 0,
      caiuDiv:  divAntes !== divDepois && dN < 0,
      quadros, esporte: m.esporte || 'tenis',
    };
    salvar();
    if(document.querySelector('#onb.on')) return;   // não atropela quem está se cadastrando
    aba='inicio'; pilha=[{rota:'mexeu'}];
    if(window.render) render();
  }catch(e){ console.error('[net] painel do que mexeu', e); }
}

/* ---- 2a: desafiar ----------------------------------------------------- */
function netDesafiar(id){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const j = S.jogadores && S.jogadores[id];
  if(!j){ alert('Jogador não encontrado.'); return; }
  // o 📍 nasce preenchido com o MEU local principal — quem marca sabe onde
  // joga; trocar é exceção, não formulário (decisão de 11/08)
  const meu = window.__meusLocais || {};
  _on = { step:'desafio', advId:id, adv:{id, nome:j.nome, nivel:j.nivel, nivelb:j.nivelB},
          localId: meu.principal || null, quadra: null, quando: null };
  netRenderOnline();
}
window.netDesafiar = netDesafiar;
function _onLocal(v){ _on.localId = v || null; _on.quadra = null; netRenderOnline(); }
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

async function _onConfirmarDesafio(){
  const adv=_on.adv;
  try{
    const { error } = await sb.from('matches').insert({
      criador_id: MEU_UID, adversario_id: adv.id,
      esporte: (typeof S!=='undefined' && S.esporte) ? S.esporte : 'tenis',
      formato:'md3', dupla:false, status:'desafiado', cantada:null,
      local_id: _on.localId || null, quadra: _on.quadra || null,
      quando: _on.quando || null,
    });
    if(error) throw error;
    netFecharOnline();
    if(window.toast) toast(`Desafio enviado pra ${adv.nome.split(' ')[0]} — ele aceita no app dele.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra desafiar: '+(e.message||e)); }
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
          fmt:'md3', localId: meu.principal || null, quadra:null, quando:null };
  netRenderOnline();
}
window.netAbrirMao = netAbrirMao;
function _maoAdv(v){ _on.advId=v||''; netRenderOnline(); }
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
  const sets=_on.sets; if(!sets){ alert('Placar incompleto. Ex: 6-3 6-4'); return; }
  let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
  if(g===p){ alert('Placar empatado — confere os sets.'); return; }
  try{
    const { error } = await sb.from('matches').insert({
      criador_id: MEU_UID, adversario_id: _on.advId,
      esporte: (typeof S!=='undefined' && S.esporte) ? S.esporte : 'tenis',
      formato:_on.fmt, dupla:false, cantada:null,
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
    if(window.toast) toast(`Placar lançado — ${nome0} confirma no app dele. Nada mexe até lá.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra lançar: '+(e.message||e)); }
}

/* ---- 2a: aceitar / recusar (do lado de quem recebeu) ------------------ */
async function netAceitar(matchId){
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

/* ---- 2b: lançar o placar (partida já aceita) -------------------------- */
async function netLancarPlacar(matchId){
  const m = _inbox.find(x=>x.id===matchId); if(!m) return;
  const advUid = _advId(m); const j = S.jogadores[_chaveLocal(advUid)] || {nome:'Jogador'};
  // ctx/fmt/dupla viajam no _on pra que a PRÉVIA mostre a mesma conta que a
  // confirmação vai aplicar — prévia que mente é pior que prévia que não existe
  _on = { step:'placar', matchId, souCriador:_souCriador(m),
          ctx:_ctxDoTorneio(await _torneioDe(m.torneio_id)), fmt:m.formato, dupla:!!m.dupla,
          adv:{id:advUid, nome:j.nome, nivel:j.nivel, nivelb:j.nivelB}, sets:null, placarTxt:'' };
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
const PRAZO_HORAS = 72;
const _vencendo = {};   // guarda de reentrada, igual ao _expirando do cinturão

function _prazoVencido(m){
  if(m.status !== 'pendente' || !m.placar_em) return false;
  return (Date.now() - new Date(m.placar_em).getTime()) > PRAZO_HORAS*3600e3;
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
  if(!m.placar_em) return null;
  const passou = (Date.now() - new Date(m.placar_em).getTime()) / 3600e3;
  return Math.max(0, PRAZO_HORAS - passou);
}
/* Mostra o PRAZO, não a contagem regressiva. Contagem tem erro de borda que
   não dá pra esconder: 71,9h restantes viram "2 dias" no floor e "3 dias" no
   ceil, e as duas leituras estão erradas de um jeito diferente. Data e hora
   não têm ambiguidade — e é o que a pessoa precisa pra se organizar.
   A contagem volta só na reta final, quando "faltam 3h" é mais útil que
   "quinta, 14h". */
const _DIAS = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
function _quandoVence(m){
  if(!m.placar_em) return null;
  return new Date(new Date(m.placar_em).getTime() + PRAZO_HORAS*3600e3);
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

async function netApurarPrazos(lista){
  let fechou = 0;
  for(const m of (lista||[])){
    if(!_prazoVencido(m) || _vencendo[m.id]) continue;
    _vencendo[m.id] = 1;
    try{ if(await _fecharPorPrazo(m)) fechou++; }
    catch(e){ console.error('[net] prazo', e); delete _vencendo[m.id]; }
  }
  if(fechou && window.toast){
    toast(`${fechou===1?'Uma partida passou':'Partidas passaram'} das ${PRAZO_HORAS}h sem confirmação — o placar valeu metade.`);
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
const _btn = (txt,onclick,tipo)=>`<button onclick="${onclick}" style="flex:1;padding:13px;border-radius:12px;
    border:1px solid var(--linha2);font:600 14px system-ui;cursor:pointer;
    background:${tipo==='ok'?'#2C5A00':tipo==='no'?'var(--dn-bg)':'var(--sup2)'};color:#fff">${txt}</button>`;
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

function netAbrirInbox(){ netRenderInbox(); }
/* "🗓 sáb 15/08 · 19h" + "📍 Clube Bahiano de Tênis · Quadra 3 — endereço" —
   informação, não campo (11/08): as linhas só aparecem quando a partida tem.
   Data ABSOLUTA, não contagem: "faltam 2 dias" mente nas bordas (o floor e o
   ceil erram de jeitos diferentes); a data não mente nunca. */
const _pinDe = (m)=>{
  let h='';
  if(m.quando){
    const d=new Date(m.quando), p=(n)=>String(n).padStart(2,'0');
    const dias=['dom','seg','ter','qua','qui','sex','sáb'];
    h+=`<div style="font-size:11.5px;color:var(--ink2);margin-top:6px">🗓 ${dias[d.getDay()]} ${p(d.getDate())}/${p(d.getMonth()+1)} · ${d.getHours()}h${d.getMinutes()?p(d.getMinutes()):''}</div>`;
  }
  const l = m.local_id && _locDe(m.local_id);
  if(l) h+=`<div style="font-size:11.5px;color:var(--ink2);margin-top:${m.quando?'3px':'6px'}">📍 ${l.nome}${m.quadra?' · Quadra '+m.quadra:''}${l.endereco?`<span style="color:var(--ink3)"> — ${l.endereco}</span>`:''}</div>`;
  return h;
};
function netRenderInbox(){
  const linhas = _inbox.map(m=>{
    const outro=_nomeDe(_advId(m)).split(' ')[0];
    let txt='', acoes='';
    if(m.status==='desafiado' && m.adversario_id===MEU_UID){
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
      acoes=`${_btn('Recusar',`_net.recusar('${m.id}')`,'no')}${_btn('Aceitar',`_net.aceitar('${m.id}')`,'ok')}`;
    } else if(m.status==='desafiado'){
      txt=`Aguardando <b>${outro}</b> aceitar seu desafio` + _pinDe(m);
    } else if(m.status==='aceito'){
      txt=`Partida marcada com <b>${outro}</b>` + _pinDe(m);
      acoes=`${_btn('Lançar placar',`_net.lancar('${m.id}')`,'ok')}`;
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
    }
    return `<div style="border:1px solid var(--linha);border-radius:14px;padding:14px;margin-top:10px">
      <div style="font-size:14px;margin-bottom:${acoes?'12px':'0'}">${txt}</div>
      ${acoes?`<div style="display:flex;gap:8px">${acoes}</div>`:''}</div>`;
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
        <div style="width:28px;height:28px;border-radius:50%;background:${(S.jogadores[_chaveLocal(p.de)]||{}).cor||'#5C2E3C'};flex:0 0 28px"></div>
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
    </div>${pedidosH}${linhas}`);
}

/* ---- UI: desafio + lançar placar (overlay _on) ------------------------ */
function _onDigitou(v){ _on.placarTxt=v; _on.sets=netParsePlacar(v); netRenderOnline(); }
function netRenderOnline(){
  let body='';
  if(_on.step==='desafio'){
    // 🗓 quando: dia e hora são a primeira coisa que dois jogadores combinam
    // (pedido de 11/08). Opcional — desafio sem hora vale como "a combinar";
    // obrigar aqui emperraria o registro, que é o elo frágil do ciclo.
    // value= preenchido de volta: trocar o local re-renderiza o sheet, e um
    // input vazio com _on.quando cheio seria estado invisível — bug fantasma
    const _p2=(n)=>String(n).padStart(2,'0');
    const qv = _on.quando ? (()=>{ const x=new Date(_on.quando);
      return `${x.getFullYear()}-${_p2(x.getMonth()+1)}-${_p2(x.getDate())}T${_p2(x.getHours())}:${_p2(x.getMinutes())}`; })() : '';
    const qdoH = `
      <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">🗓 Quando <span style="color:var(--ink3)">(opcional — sem data vale "a combinar")</span></div>
      <input type="datetime-local" value="${qv}" onchange="_net.onQuando(this.value)"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;color-scheme:dark"/>
      <div style="height:12px"></div>`;
    // 📍 da partida: nasce com o local principal do desafiante, dá pra trocar
    // ou tirar. A quadra é opcional e limitada ao nº real de quadras do local.
    const ls=_locaisMarcaveis(); const lSel=_locDe(_on.localId);   // clube do ADM + as minhas quadras
    const locH = ls.length ? `
      <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">📍 Onde</div>
      <select onchange="_net.onLocal(this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">
        <option value="" ${!_on.localId?'selected':''}>A combinar</option>
        ${ls.map(l=>`<option value="${l.id}" ${_on.localId===l.id?'selected':''}>${l.nome}</option>`).join('')}
      </select>
      ${lSel?`<input type="number" min="1" max="${lSel.quadras}" value="${_on.quadra||''}" oninput="_net.onQuadra(this.value)" placeholder="Quadra (opcional, 1–${lSel.quadras})"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:8px">`:''}
      <div style="height:14px"></div>` : '';
    body = `<div style="font:700 17px system-ui;margin-bottom:2px">Desafiar ${_on.adv.nome}</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:14px">Ele recebe o desafio e aceita (ou recusa) no app dele. Depois de aceito é que vocês lançam o placar.</div>
      ${qdoH}${locH}
      <div style="display:flex;gap:8px">${_btn('Cancelar','_net.fechar()')}${_btn('Desafiar','_net.confirmarDesafio()','ok')}</div>
      <div style="font-size:11px;color:var(--ink3);margin-top:12px;text-align:center">Cantar a pedra (apostar como vai ganhar) entra aqui em breve.</div>`;
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
      const advNivel=(S.esporte==='beach')?(adv.nivelB??1200):(adv.nivel??1200);
      const c=calcular(nivelDe(eu), advNivel, venceu, 'amistoso', _on.fmt, false, eu.calibrando, eu.cal);
      previa=`<div style="display:flex;gap:14px;justify-content:center;margin:12px 0">
        <div style="text-align:center"><div style="font:700 20px system-ui;color:${c.dNivel>=0?'var(--up)':'var(--dn)'}">${c.dNivel>0?'+':''}${c.dNivel}</div><div style="font-size:10px;color:var(--ink2)">NÍVEL</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui;color:var(--up)">+${c.dPts}</div><div style="font-size:10px;color:var(--ink2)">PONTOS</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui">${venceu?'Vitória':'Derrota'}</div><div style="font-size:10px;color:var(--ink2)">RESULTADO</div></div>
      </div>`;
    }
    body=`<div style="font:700 17px system-ui;margin-bottom:2px">Lançar na mão</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:12px">Partida jogada fora do app. ${_on.advId?_nomeDe(_on.advId).split(' ')[0]+' recebe o placar e':'O adversário recebe o placar e'} confirma no app dele — com o mesmo prazo de 72h. Não vai contar em circuito aberto, só nas fechadas.</div>
      <div style="font-size:12px;color:var(--ink2);margin:2px 0 6px">Contra quem</div>
      <select onchange="_net.maoAdv(this.value)" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui">
        <option value="" ${!_on.advId?'selected':''}>Escolher…</option>
        ${eleg.map(u=>`<option value="${u}" ${_on.advId===u?'selected':''}>${_nomeDe(u)}${netEhAmigo(u)?' · amigo':''}</option>`).join('')}
      </select>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Amigo em qualquer classe; fora isso, a mesma janela de ±1 classe do radar.</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        ${[['md3','Melhor de 3'],['set','Set único']].map(([v,n])=>`<button onclick="_net.maoFmt('${v}')" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--linha2);font:600 12px system-ui;cursor:pointer;background:${_on.fmt===v?'#2C5A00':'var(--sup2)'};color:#fff">${n}</button>`).join('')}
      </div>
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
      ${lSel?`<input type="number" min="1" max="${lSel.quadras}" value="${_on.quadra||''}" oninput="_net.onQuadra(this.value)" placeholder="Quadra (opcional, 1–${lSel.quadras})"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 14px system-ui;margin-top:8px">`:''}`:''}
      <div style="display:flex;gap:8px;margin-top:14px">${_btn('Cancelar','_net.fechar()')}${(_on.sets&&_on.advId)?_btn('Lançar placar','_net.maoEnviar()','ok'):''}</div>`;
  }
  else if(_on.step==='placar'){
    const eu=S.jogadores[EU]; const sets=_on.sets; let previa='';
    if(sets){
      let g=0,p=0; sets.forEach(([a,b])=>{ if(a>b)g++; else if(b>a)p++; });
      const venceu=g>p;
      const advNivel=(S.esporte==='beach')?(_on.adv.nivelb??1200):(_on.adv.nivel??1200);
      const c=calcular(nivelDe(eu), advNivel, venceu, _on.ctx||'amistoso', _on.fmt, !!_on.dupla, eu.calibrando, eu.cal);
      previa=`<div style="display:flex;gap:14px;justify-content:center;margin:14px 0">
        <div style="text-align:center"><div style="font:700 20px system-ui;color:${c.dNivel>=0?'var(--up)':'var(--dn)'}">${c.dNivel>0?'+':''}${c.dNivel}</div><div style="font-size:10px;color:var(--ink2)">NÍVEL</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui;color:var(--up)">+${c.dPts}</div><div style="font-size:10px;color:var(--ink2)">PONTOS</div></div>
        <div style="text-align:center"><div style="font:700 20px system-ui">${venceu?'Vitória':'Derrota'}</div><div style="font-size:10px;color:var(--ink2)">RESULTADO</div></div>
      </div>${c.zebra?'<p style="text-align:center;color:var(--up);font-size:12px">Zebra — multiplicador nos pontos.</p>':''}`;
    }
    body=`<div style="font:700 17px system-ui;margin-bottom:2px">Placar vs ${_on.adv.nome}</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:10px">Seus games primeiro. Ex: <b>6-3 6-4</b></div>
      <input id="net-sc" value="${_on.placarTxt||''}" oninput="_net.digitou(this.value)" placeholder="6-3 6-4"
        style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 18px system-ui;text-align:center;letter-spacing:.05em" autocomplete="off"/>
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
function netAbrirBusca(){ _busca={termo:'',resultados:[]}; netRenderBusca(); }
function netFecharBusca(){ const el=document.getElementById('net-busca'); if(el) el.remove(); }
async function _onBuscar(v){ _busca.termo=v; _busca.resultados = await netBuscar(v); netRenderBusca(); }
window.netRenderBusca = netRenderBusca;
function netRenderBusca(){
  const linhas=_busca.resultados.map(p=>{
    const amigo=netEhAmigo(p.id);
    const div=window.divisaoDe?divisaoDe(p.nivel):'';
    const nomeEsc=(p.nome||'').replace(/'/g,'’');
    return `<div style="display:flex;align-items:center;gap:11px;padding:11px;border:1px solid var(--linha);border-radius:12px;margin-top:8px">
      <div style="width:36px;height:36px;border-radius:50%;background:${p.cor||'#5C2E3C'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex:0 0 36px">${p.ap||'?'}</div>
      <div style="flex:1;min-width:0"><b>${p.nome}</b> <span style="color:var(--ink3);font-size:11px">${netId(p.id)}</span>
        <div style="font-size:11px;color:var(--ink2)">Classe ${div} · Nível ${p.nivel}${amigo?' · <span style="color:var(--up)">✔ amigo</span>':''}</div></div>
      <div style="display:flex;flex-direction:column;gap:5px">
        ${amigo?'':`<button onclick="_net.addAmigo('${p.id}')" style="padding:7px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:600 12px system-ui;cursor:pointer">Pedir amizade</button>`}
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
    return `<div style="display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--sup2)">
      <div style="width:22px;text-align:center;font:700 12px system-ui;color:${i===0?'var(--gold)':'var(--ink2)'};flex:0 0 22px">${i+1}º</div>
      <div style="width:28px;height:28px;border-radius:50%;background:${(S.jogadores[_chaveLocal(p.player_id)]||{}).cor||'#5C2E3C'};flex:0 0 28px"></div>
      <div style="flex:1;min-width:0"><b>${_nomeDe(p.player_id)}</b>
        ${ehDono?'<span style="color:var(--gold);font-size:11px"> dono</span>':p.papel==='admin'?'<span style="color:var(--up);font-size:11px"> admin</span>':''}
        <div style="font-size:11px;color:var(--ink2)"><b style="color:var(--up)">${ptsG[p.player_id]||0}</b> pts · Nível ${nivelG[p.player_id]??'—'}</div></div>
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
  // patches da comunidade (migração 22) — todo membro cria e manda
  const patchesBtn = meu ? `<button onclick="_net.abrirPatches('${gid}')" style="width:100%;padding:12px;border-radius:11px;border:1px solid var(--linha2);background:var(--sup);color:var(--ink);font:600 13px system-ui;cursor:pointer;margin-top:14px">◈ Patches da comunidade — criar e mandar</button>` : '';
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
    ${pedidosH}${entrar}${patchesBtn}${sair}${link}`);
}
function netFecharGver(){ const el=document.getElementById('net-gver'); if(el) el.remove(); }
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
async function netAbrirTorneios(){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const {meus,abertos,cont}=await netMeusTorneios();
  const card=(t,entrar)=>{
    const n=cont[t.id]||0; const esp=t.tipo==='multi'?((t.categorias||[]).length+' categorias'):(t.esporte==='beach'?'Beach':'Tênis');
    const regra=t.tipo==='restrito'&&t.classes?' · div. '+t.classes.join('/'):'';
    return `<div class="tsheet-item" onclick="_net.verTorneio('${t.id}')" style="display:flex;align-items:center;gap:11px;padding:13px;border:1px solid var(--linha);border-radius:12px;margin-top:8px;cursor:pointer">
      <div style="width:34px;height:34px;border-radius:9px;background:var(--sup2);display:flex;align-items:center;justify-content:center;font-size:16px;flex:0 0 34px">🏆</div>
      <div style="flex:1;min-width:0"><b>${t.nome}</b>
        <div style="font-size:11px;color:var(--ink2)">${esp} · mata-mata · ${n}${t.tipo==='multi'?'':'/'+t.tamanho} inscritos${regra} · ${t.aberto?'aberto':'fechado'}${t.status!=='inscricoes'?' · '+t.status:''}</div></div>
      ${entrar?`<button onclick="event.stopPropagation();_net.entrarTorneio('${t.id}')" style="padding:7px 12px;border-radius:9px;border:none;background:#2C5A00;color:#fff;font:600 12px system-ui;cursor:pointer">Entrar</button>`:'<span style="color:var(--ink2)">›</span>'}
    </div>`;
  };
  const meusH = meus.length? meus.map(t=>card(t,false)).join('') : `<p style="color:var(--ink2);font-size:13px;margin-top:8px">Você não está em nenhum torneio ainda.</p>`;
  const abH = abertos.length? `<div style="font:700 12px system-ui;color:var(--ink2);margin-top:16px;text-transform:uppercase;letter-spacing:.08em">Torneios abertos</div>`+abertos.map(t=>card(t,true)).join('') : '';
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
    tipo:t.tipo||'aberto', classes:t.classes||[], cats:t.categorias||[] };
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
      <div style="width:28px;height:28px;border-radius:50%;background:${(S.jogadores[_chaveLocal(p.player_id)]||{}).cor||'#5C2E3C'};flex:0 0 28px"></div>
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
function netAbrirLogin(){
  _sheet('net-login', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Acessar minha conta</div>
      <button onclick="document.getElementById('net-login').remove()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:8px 0 12px">Entre com o email e a senha da sua conta.</div>
    <input id="nl-email" type="email" placeholder="seu email" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui" autocomplete="email" inputmode="email"/>
    <input id="nl-senha" type="password" placeholder="sua senha" style="width:100%;padding:13px;border-radius:12px;border:1px solid var(--linha2);background:var(--bg);color:#fff;font:600 15px system-ui;margin-top:10px" autocomplete="current-password"/>
    <button onclick="_net.enviarLogin(document.getElementById('nl-email').value, document.getElementById('nl-senha').value)" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:12px">Entrar</button>
    <button onclick="_net.esqueciSenha(document.getElementById('nl-email').value)" style="width:100%;padding:11px;border:none;background:none;color:var(--ink2);font:600 13px system-ui;cursor:pointer;margin-top:4px;text-decoration:underline">Esqueci minha senha</button>`);
  const el=document.getElementById('nl-email'); if(el) el.focus();
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
let _meusLocais = null;  // [{local_id, principal}] — os MEUS
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
      .select('id,nome,tipo,quadras,cidade_id,regiao_id,origem,dono_id,locais_endereco(endereco)')
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

async function netMeusLocais(force){
  if(_meusLocais && !force) return _meusLocais;
  if(!MEU_UID) return [];
  const r = await sb.from('player_locais').select('local_id,principal').eq('player_id', MEU_UID);
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
  const linhas=(_locais||[]).map(l=>{
    const on=_loc.sel.includes(l.id), pr=_loc.principal===l.id;
    return `<div style="display:flex;align-items:center;gap:10px;padding:11px 2px;border-bottom:1px solid var(--sup2)">
      <button onclick="_net.locToggle('${l.id}')" style="width:24px;height:24px;border-radius:7px;border:1px solid ${on?'#2C5A00':'var(--linha2)'};background:${on?'#2C5A00':'var(--bg)'};color:#fff;font:700 13px system-ui;cursor:pointer;flex:0 0 24px">${on?'✓':''}</button>
      <div style="flex:1;min-width:0"><b style="font-size:14px">${l.nome}</b>
        <div style="font-size:11px;color:var(--ink2)">${TIPO[l.tipo]||''}${TIPO[l.tipo]?' · ':''}${l.quadras} quadra${l.quadras>1?'s':''}${l.cidade?' · '+l.cidade:''}</div>
        ${l.endereco?`<div style="font-size:10.5px;color:var(--ink3)">${l.endereco}</div>`:''}</div>
      ${on?`<button onclick="_net.locPrincipal('${l.id}')" style="padding:6px 10px;border-radius:9px;border:1px solid ${pr?'var(--gold-bg)':'var(--linha2)'};background:${pr?'var(--gold-bg)':'var(--sup2)'};color:${pr?'var(--gold)':'var(--ink2)'};font:600 11px system-ui;cursor:pointer">${pr?'★ principal':'tornar principal'}</button>`:''}
    </div>`;
  }).join('');
  _sheet('net-locais', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">📍 Onde você joga</div>
      <button onclick="_net.fecharLocais()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 8px">Marque os lugares onde você costuma jogar. O <b>principal</b> vira o endereço dos seus desafios e diz sua cidade — dá pra jogar em mais de um.</div>
    ${linhas || '<p style="color:var(--ink2);font-size:13px;margin:14px 0">Nenhum clube cadastrado ainda. Fala com o ADM do app pra incluir o seu — por enquanto dá pra jogar sem local.</p>'}
    <button onclick="_net.locSalvar()" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:16px">Salvar</button>`);
}

/* ---- meus troféus (a Sala de Conquistas lê o BANCO, não só os torneios) ----
   Descoberto em 11/08 testando o ADM: a sala derivava tudo (torneios, selos
   locais) e nunca leu trofeus_temporada — Reinado, Coroa e troféu do ADM
   existiam no banco e não apareciam pra ninguém. */
async function netMeusTrofeus(){
  if(!MEU_UID) return [];
  const r = await sb.from('trofeus_temporada')
    .select('id,tipo,nome,etiqueta,origem,temporada,grupo_id,criado_em')
    .eq('player_id', MEU_UID).order('criado_em', {ascending:false});
  return r.data || [];
}

/* =========================================================================
   DECLARAÇÃO DE IDADE NO LOGIN (11/08) — pras contas anteriores à migração 15.
   A mesma trava do cadastro (18 anos), no mesmo vocabulário: a data é o dado,
   a declaração é o fato histórico — guarda os dois. Menor de 18 declarado
   sai da conta na hora: a regra da abertura ("só para maiores de 18") vale
   pra conta velha igual vale pra nova.
   ========================================================================= */
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

async function netMeusPatches(){
  if(!MEU_UID) return [];
  const es=(await sb.from('patch_envios').select('patch_id,de,criado_em').eq('para',MEU_UID)).data||[];
  if(!es.length) return [];
  const ps=(await sb.from('patches').select('id,nome,grupo_id,origem,criado_por').in('id',es.map(e=>e.patch_id))).data||[];
  const porId={}; ps.forEach(p=>porId[p.id]=p);
  return es.map(e=>({ ...e, patch:porId[e.patch_id] })).filter(x=>x.patch)
           .sort((a,b)=>(b.criado_em||'').localeCompare(a.criado_em||''));
}

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
    sb.from('locais').select('id,nome,tipo,quadras,ativo,regiao_id,locais_endereco(endereco)')
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
  _adm.novo = { nome:'', etiqueta:'', grupo_id:'', patch:'' };
  const [t, g] = await Promise.all([
    sb.from('trofeus_temporada').select('id,tipo,nome,etiqueta,origem,temporada,grupo_id,criado_em')
      .eq('player_id', id).order('criado_em', {ascending:false}),
    sb.from('grupo_membros').select('grupo_id, grupos(id,nome)').eq('player_id', id),
  ]);
  _adm.trofeus = t.data || [];
  _adm.grupos  = (g.data||[]).map(x=>x.grupos).filter(Boolean);
  netRenderAdm();
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

function netRenderAdm(){
  const abaBtn=(id,txt)=>`<button onclick="_net.admAba('${id}')" style="flex:1;padding:10px;border-radius:10px;
    border:1px solid var(--linha2);font:600 13px system-ui;cursor:pointer;
    background:${_adm.aba===id?'var(--up-bg)':'var(--sup2)'};color:${_adm.aba===id?'var(--up)':'#fff'}">${txt}</button>`;

  let corpo='';

  if(_adm.aba==='trofeus'){
    const achados = _adm.achados.map(p=>`
      <div onclick="_net.admSel('${p.id}','${_admEsc((p.nome||'').replace(/'/g,'’'))}')"
        style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--linha);border-radius:11px;margin-top:7px;cursor:pointer">
        <div style="width:32px;height:32px;border-radius:50%;background:${p.cor||'#5C2E3C'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:0 0 32px">${_admEsc(p.ap||'?')}</div>
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
        <b>${_admEsc(l.nome)}</b>
        <div style="font-size:11px;color:var(--ink2)">${_admEsc(l.tipo)} · ${l.quadras} ${l.quadras===1?'quadra':'quadras'}${l.endereco?' · '+_admEsc(l.endereco):''}</div>
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
  lancar:netLancarPlacar, digitou:_onDigitou, enviar:_onEnviar, confirmar:netConfirmar, contestar:netContestar,
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
  esqueciSenha:netEsqueciSenha, salvarNovaSenha:netSalvarNovaSenha,
  abrirAdm:netAbrirAdm, fecharAdm:netFecharAdm, admAba:_admAba, admBuscar:_admBuscar,
  admSel:_admSel, admSet:_admSet, admDar:_admDar, admApagar:_admApagar,
  admLocSet:_admLocSet, admSalvarLocal:_admSalvarLocal,
  admRegSet:_admRegSet, admCriarRegiao:_admCriarRegiao, admApagarRegiao:_admApagarRegiao,
  admLocalRegiao:_admLocalRegiao,
  meusQuadros:netMeusQuadros, quadrosDaPartida:netQuadrosDaPartida, destaques:netDestaques,
  locais:netLocais, meusLocais:netMeusLocais, salvarMeusLocais:netSalvarMeusLocais,
  abrirLocais:netAbrirMeusLocais, fecharLocais:netFecharMeusLocais,
  locToggle:_locToggle, locPrincipal:_locPrincipal, locSalvar:_locSalvar,
  /* 13/08: `onQuando` ficou de fora quando o campo de data entrou (mig 21) e os
     irmãos dela — `onLocal` e `onQuadra` — foram exportados. A função existia,
     só não estava no `_net`, então o `onchange` do datetime-local morria em
     silêncio nas DUAS folhas que o usam (desafiar e lançar na mão): o horário
     escolhido nunca chegava em `_on.quando` e a partida saía sem hora. */
  onLocal:_onLocal, onQuadra:_onQuadra, onQuando:_onQuando,
  gcasa:netDefinirCasa, meusTrofeus:netMeusTrofeus,
  abrirPatches:netAbrirPatches, fecharPatches:netFecharPatches, patDigitou:_patDigitou,
  patMandando:_patMandando, patCriar:_patCriar, patMandar:_patMandar,
  admDarPatch:_admDarPatch, meusPatches:netMeusPatches,
  pedirIdade:netPedirIdade, idadeConfirmar:_idadeConfirmar,
  abrirMao:netAbrirMao, maoAdv:_maoAdv, maoFmt:_maoFmt, maoEnviar:_maoEnviar };
window.netAbrirMeusLocais = netAbrirMeusLocais;
window.netAbrirInbox = netAbrirInbox;
