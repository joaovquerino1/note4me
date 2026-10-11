# Limitações conhecidas

Lista honesta do que não está implementado ou tem comportamento limitado nesta versão (0.1.0).

## Markdown

Blocos **não editados** são gravados byte a byte. Em blocos **editados**, o note4me reescreve em estilo convencional:

- quebras de linha simples dentro de um parágrafo viram espaços; títulos setext (`===`) viram ATX (`#`); código indentado vira bloco cercado (```` ``` ````);
- caracteres de sintaxe digitados como texto literal são escapados (`\*`, `\[`);
- links de referência (`[texto][ref]`) viram links em linha; as definições `[ref]: url` são preservadas no arquivo, mas não aparecem no editor visual;
- informações extras na linha de abertura de código (```` ```js title=x ````) mantêm só a linguagem;
- tabelas não suportam células mescladas; quebras dentro de célula viram `<br>`;
- sublinhado não existe em Markdown e está desativado.

Sintaxes sem equivalente visual (HTML, notas de rodapé, matemática, embeds `![[…]]`) são mantidas verbatim e editáveis como texto, sem renderização (matemática não é desenhada).

## Links

- Renomear uma página reescreve `[[Nome]]` por nome; se houver páginas homônimas em pastas diferentes, links wiki para a outra página com o mesmo nome também podem ser alterados nas páginas que apontam para a renomeada.
- Âncoras `#seção` não são atualizadas quando um título de seção muda.
- Renomeações feitas **fora** do app não reescrevem links (o app não tem como saber a intenção); os links aparecem como quebrados.

## Edição e recuperação

- Recarregar após uma alteração externa reposiciona o cursor no início.
- Rascunhos de recuperação são gravados quando um salvamento falha ou entra em conflito, e ao trocar de página/fechar a janela as edições pendentes são salvas. Um encerramento abrupto do processo pode perder até o intervalo do salvamento automático (padrão 0,8 s).
- O histórico guarda no máximo uma versão por intervalo (padrão 5 min) e sempre antes de sobrescrever uma alteração externa ou restaurar.
- "Duplicar" copia apenas a página, não suas subpáginas.

## Coleções

- Tipos são inferidos dos valores; não há tipos "seleção" com opções definidas nem relações entre registros.
- Filtros combinam com E (não há OU).

## Plataforma, compartilhamento e sincronização

- A interface é renderizada pelo WebKit (Tauri), não por controles AppKit.
- Não há folha de compartilhamento nativa do macOS; compartilhe por "Mostrar no Finder", exportação com anexos ou "Copiar Markdown". Não há compartilhamento por link nem sincronização própria — use iCloud Drive, Git ou outra ferramenta de arquivos.
- Arquivos do iCloud Drive "somente na nuvem" (não baixados) não são baixados pelo app.
- A lixeira fica dentro do vault e, portanto, também é sincronizada.

## Acessibilidade

- Papéis, rótulos e navegação por teclado foram implementados e a navegação por teclado é verificada no teste E2E; a experiência com **VoiceOver não foi validada manualmente** nesta versão.
- Atkinson Hyperlegible e OpenDyslexic não são distribuídas com o app (devem ser instaladas pelo usuário; ambas têm licença SIL OFL).

## Distribuição

- O build não está assinado nem notarizado (veja [DISTRIBUICAO.md](DISTRIBUICAO.md)); o Gatekeeper exibirá um aviso na primeira abertura.
- Apenas macOS foi testado.

## Testes

- Não há testes automatizados de interface com WebDriver no macOS (o `tauri-driver` não suporta a plataforma); a cobertura de interface vem do teste E2E interno e de revisão visual por capturas.
