# app-tenis-web

Build público do **App de Tênis** — só o que o app precisa pra rodar no navegador.
É este repositório que o GitHub Pages serve.

O app abre em `app/`. A raiz redireciona pra lá.

## O que NÃO vive aqui

O código-fonte de trabalho, os documentos de produto, o SQL das migrações e as
ferramentas de calibragem ficam no repositório privado `Walk-to-Digital/app-tenis`.
Este aqui é destino de publicação, não origem: editar arquivo direto aqui faz o
conteúdo divergir da fonte e ser sobrescrito na próxima publicação.

## Sobre a chave do Supabase

A chave em `app/net.js` é a publishable (anon) — pública por design. Quem protege
os dados é a RLS no banco, não o segredo da chave.
