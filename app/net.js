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

async function netAddAmigo(uid){
  if(!MEU_UID || uid === MEU_UID) return;
  const [a, b] = _par(MEU_UID, uid);
  const { error } = await sb.from('amizades')
    .upsert({ a, b, criada_por: MEU_UID }, { onConflict: 'a,b', ignoreDuplicates: true });
  if(error){
    console.error('[net] add amigo', error);
    if(window.toast) toast('Não deu pra adicionar agora. Tente de novo.');
    return;                      // não mexe no estado local se o banco recusou
  }
  const meus=_meusAmigos(); if(!meus.includes(uid)){ meus.push(uid); salvar(); }
  if(window.render) render();
  if(window.netRenderBusca) netRenderBusca();
  if(window.toast) toast('Amigos. Agora <b>os dois</b> podem se desafiar em qualquer classe.');
}
window.netAddAmigo = netAddAmigo;

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
  // badge do ✉ na home = quantas partidas pedem a minha ação
  if(typeof S!=='undefined'){ S.novidades = _inbox.filter(netAcionavel).length; if(window.render) render(); }
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
    const nome0 = _nomeDe(_advId(m)).split(' ')[0];
    if(window.toast){
      toast(m.fechada_por_prazo
        ? `${nome0} não confirmou em 72h — o placar fechou sozinho valendo <b>metade</b> · Nível ${(meu.dNivel>=0?'+':'')}${meu.dNivel}`
        : `Partida com ${nome0} confirmada · Nível ${(meu.dNivel>=0?'+':'')}${meu.dNivel}`);
    }
  });
  if(mexeu){ salvar(); if(window.render) render(); netSyncJogador(S.jogadores[EU]).catch(()=>{}); }
}

/* ---- 2a: desafiar ----------------------------------------------------- */
function netDesafiar(id){
  if(!MEU_UID){ alert('Ainda conectando…'); return; }
  const j = S.jogadores && S.jogadores[id];
  if(!j){ alert('Jogador não encontrado.'); return; }
  _on = { step:'desafio', advId:id, adv:{id, nome:j.nome, nivel:j.nivel, nivelb:j.nivelB} };
  netRenderOnline();
}
window.netDesafiar = netDesafiar;

async function _onConfirmarDesafio(){
  const adv=_on.adv;
  try{
    const { error } = await sb.from('matches').insert({
      criador_id: MEU_UID, adversario_id: adv.id,
      esporte: (typeof S!=='undefined' && S.esporte) ? S.esporte : 'tenis',
      formato:'md3', dupla:false, status:'desafiado', cantada:null,
    });
    if(error) throw error;
    netFecharOnline();
    if(window.toast) toast(`Desafio enviado pra ${adv.nome.split(' ')[0]} — ele aceita no app dele.`);
    netAtualizarInbox();
  }catch(e){ alert('Não deu pra desafiar: '+(e.message||e)); }
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
      <!-- 11/08: regra que só existe no documento não muda comportamento. A
           decisão "recusar não custa fair play" existia desde o protótipo do
           radar e nunca chegou à tela — e quem não sabe que é de graça acaba
           aceitando jogo que não quer, ou some sem responder. -->
      <div style="font-size:11.5px;color:var(--ink3);margin-top:7px">Recusar não custa nada — não mexe no seu nível nem na sua reputação.</div>`;
      acoes=`${_btn('Recusar',`_net.recusar('${m.id}')`,'no')}${_btn('Aceitar',`_net.aceitar('${m.id}')`,'ok')}`;
    } else if(m.status==='desafiado'){
      txt=`Aguardando <b>${outro}</b> aceitar seu desafio`;
    } else if(m.status==='aceito'){
      txt=`Partida marcada com <b>${outro}</b>`;
      acoes=`${_btn('Lançar placar',`_net.lancar('${m.id}')`,'ok')}`;
    } else if(m.status==='pendente' && m.placar_por!==MEU_UID){
      const euVenci = _souCriador(m) ? m.venceu_criador : !m.venceu_criador;
      const meuPl = _souCriador(m) ? m.placar : _inverter(m.placar);
      txt=`<b>${outro}</b> lançou o placar: você <b style="color:${euVenci?'var(--up)':'var(--dn)'}">${euVenci?'venceu':'perdeu'}</b> ${meuPl}`
         + _avisoPrazo(m, 'confirmar');
      acoes=`${_btn('Contestar',`_net.contestar('${m.id}')`,'no')}${_btn('Confirmar',`_net.confirmar('${m.id}')`,'ok')}`;
    } else if(m.status==='pendente'){
      txt=`Aguardando <b>${outro}</b> confirmar o placar` + _avisoPrazo(m, 'esperar');
    }
    return `<div style="border:1px solid var(--linha);border-radius:14px;padding:14px;margin-top:10px">
      <div style="font-size:14px;margin-bottom:${acoes?'12px':'0'}">${txt}</div>
      ${acoes?`<div style="display:flex;gap:8px">${acoes}</div>`:''}</div>`;
  }).join('') || `<p style="color:var(--ink2);font-size:13px;margin-top:8px">Nenhuma partida rolando. Vá no Radar e desafie alguém.</p>`;
  _sheet('net-inbox', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">Suas partidas</div>
      <button onclick="_net.fecharInbox()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button>
    </div>${linhas}`);
}

/* ---- UI: desafio + lançar placar (overlay _on) ------------------------ */
function _onDigitou(v){ _on.placarTxt=v; _on.sets=netParsePlacar(v); netRenderOnline(); }
function netRenderOnline(){
  let body='';
  if(_on.step==='desafio'){
    body = `<div style="font:700 17px system-ui;margin-bottom:2px">Desafiar ${_on.adv.nome}</div>
      <div style="font-size:12px;color:var(--ink2);margin-bottom:14px">Ele recebe o desafio e aceita (ou recusa) no app dele. Depois de aceito é que vocês lançam o placar.</div>
      <div style="display:flex;gap:8px">${_btn('Cancelar','_net.fechar()')}${_btn('Desafiar','_net.confirmarDesafio()','ok')}</div>
      <div style="font-size:11px;color:var(--ink3);margin-top:12px;text-align:center">Cantar a pedra (apostar como vai ganhar) entra aqui em breve.</div>`;
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
        ${amigo?'':`<button onclick="_net.addAmigo('${p.id}')" style="padding:7px 10px;border-radius:9px;border:1px solid var(--linha2);background:var(--sup2);color:#fff;font:600 12px system-ui;cursor:pointer">+ Amigo</button>`}
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
    <div style="font-size:11px;color:var(--ink3);text-align:center;margin-top:5px">Manda no WhatsApp — quem abrir vira seu amigo no app.</div>
    ${linhas}`);
  const bq=document.getElementById('net-bq'); if(bq){ bq.focus(); bq.setSelectionRange(bq.value.length,bq.value.length); }
}

// convite de amizade por link (?a=<meu uid>) — quem abre me adiciona
async function netConvidarAmigo(){
  const url = location.origin + location.pathname + '?a=' + MEU_UID;
  try{ await navigator.clipboard.writeText(url); if(window.toast) toast('Link copiado! Quem abrir vira seu amigo.'); }
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
      if(reinado) linhas.push({temporada:temp.n, grupo_id, tipo:'reinado', ...reinado});
      if(coroa)   linhas.push({temporada:temp.n, grupo_id, tipo:'coroa',   ...coroa});
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
    <button onclick="_net.gcriar()" style="width:100%;padding:14px;border-radius:12px;border:none;background:#2C5A00;color:#fff;font:700 14px system-ui;cursor:pointer;margin-top:18px">Criar comunidade</button>`);
  const el=document.getElementById('gn-nome'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); }
}
function _gset(campo,v){ if(v==='true')v=true; if(v==='false')v=false; _gnew[campo]=v; if(campo!=='nome') netCriarGrupoUI(); }
async function _gcriar(){
  if(!_gnew.nome || !_gnew.nome.trim()){ alert('Dá um nome pra comunidade.'); return; }
  try{ if(window.netSyncJogador && typeof S!=='undefined') await netSyncJogador(S.jogadores[EU]); }catch(e){}
  const { data, error } = await sb.from('grupos').insert({ nome:_gnew.nome, dono_id:MEU_UID, esporte:_gnew.esporte, aberto:!!_gnew.aberto }).select().single();
  if(error){ alert('Erro ao criar: '+error.message); return; }
  await sb.from('grupo_membros').insert({ grupo_id:data.id, player_id:MEU_UID, papel:'dono' });
  _gnew=null; const el=document.getElementById('net-gnew'); if(el) el.remove();
  if(window.toast) toast('Comunidade criada! Manda o link pros amigos.');
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

  _sheet('net-gver', `<div style="display:flex;justify-content:space-between;align-items:center">
      <div style="font:700 17px system-ui">${g.nome}</div>
      <button onclick="_net.fecharGver()" style="background:none;border:none;color:var(--ink2);font-size:22px;cursor:pointer">×</button></div>
    <div style="font-size:12px;color:var(--ink2);margin:4px 0 12px">${g.esporte==='beach'?'Beach':'Tênis'} · ${ms.length} membros · ${g.aberto?'aberto':'fechado'}</div>
    ${cinturaoH}
    ${ms.map(linha).join('')||'<p style="color:var(--ink2);font-size:13px">Ninguém ainda.</p>'}
    ${pedidosH}${entrar}${sair}${link}`);
}
function netFecharGver(){ const el=document.getElementById('net-gver'); if(el) el.remove(); }

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
  // convite de AMIZADE (?a=<uid de quem convidou>)
  const aUid = p.get('a');
  if(aUid){ history.replaceState(null,'',location.pathname);
    if(aUid!==MEU_UID){ try{ window.aplicarJogadoresReais && aplicarJogadoresReais(await netAdversarios()); }catch(e){} await netAddAmigo(aUid); }
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

// exposto pro app e pros onclick
window.netAbrirTorneios = netAbrirTorneios;
window._net = { sb, netEntrar, netSyncJogador, netAdversarios, netBoot, uid:()=>MEU_UID,
  desafiar:netDesafiar, confirmarDesafio:_onConfirmarDesafio, aceitar:netAceitar, recusar:netRecusar,
  lancar:netLancarPlacar, digitou:_onDigitou, enviar:_onEnviar, confirmar:netConfirmar, contestar:netContestar,
  abrirInbox:netAbrirInbox, fecharInbox:netFecharInbox, fechar:netFecharOnline,
  abrirBusca:netAbrirBusca, fecharBusca:netFecharBusca, buscar:_onBuscar, addAmigo:netAddAmigo, desafiarUid:netDesafiarUid,
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
  esqueciSenha:netEsqueciSenha, salvarNovaSenha:netSalvarNovaSenha };
window.netAbrirInbox = netAbrirInbox;
