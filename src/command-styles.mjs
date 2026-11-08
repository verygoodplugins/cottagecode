/** Installed inside the existing town shell; no global typography or theme changes. */
export const commandStyles = `
#map-shell{--cc-paper:#e9e0c9;--cc-brass:#cfad70;--cc-muted:#b3b5ad;--cc-line:#465048;--cc-ground:#25312f}
#map-shell .cc-bar,#map-shell .cc-attention,#map-shell .cc-surface,#map-shell .cc-search,#map-shell .cc-preview{font-family:ui-sans-serif,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;color:var(--cc-paper)}
#map-shell .cc-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:0 0 8px;padding-bottom:8px;border-bottom:1px solid var(--cc-line)}
#map-shell .cc-views{display:flex;gap:3px;padding:3px;background:#192321;border:1px solid var(--cc-line);border-radius:5px}
#map-shell .cc-bar button,#map-shell .cc-attention button,#map-shell .cc-surface button,#map-shell .cc-search button{font:inherit;color:inherit;cursor:pointer}
#map-shell .cc-bar button,#map-shell .cc-filter-row button,#map-shell .cc-locate{background:transparent;border:1px solid transparent;border-radius:3px;padding:6px 10px}
#map-shell .cc-bar button[aria-pressed=true],#map-shell .cc-filter-row button[aria-pressed=true]{background:#425047;border-color:#7e8060;color:#fff1cb}
#map-shell .cc-bar button:hover,#map-shell .cc-filter-row button:hover{background:#39433b}
#map-shell .cc-key{font:10px ui-monospace,monospace;color:#a5ac9d;margin-right:5px}
#map-shell .cc-tools{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
#map-shell .cc-label{display:flex;gap:5px;align-items:center;color:var(--cc-muted);font-size:12px}
#map-shell .cc-bar select,#map-shell .cc-trace select{max-width:180px;background:#25312c;color:var(--cc-paper);border:1px solid #627064;border-radius:3px;font:inherit;padding:5px}
#map-shell .cc-bar .cc-search-open{border-color:#627064;background:#2d3731}
#map-shell .cc-attention{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;background:#303831;border-left:3px solid var(--cc-brass);margin-bottom:8px;border-radius:0 4px 4px 0}
#map-shell .cc-attention.cc-calm{border-left-color:#7a9d86}
#map-shell .cc-attention-label{color:var(--cc-brass);font-size:11px;white-space:nowrap;font-weight:650;letter-spacing:.03em}
#map-shell .cc-attention-main{border:0;background:none;text-align:left;min-width:0;flex:1;padding:0;display:block}
#map-shell .cc-attention-main strong{display:block;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#map-shell .cc-attention-main span{display:block;color:#efdfb9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#map-shell .cc-attention-meta{font-size:11px;color:var(--cc-muted);max-width:260px}
#map-shell .cc-attention-next{background:#414a3d;border:1px solid #6b775b;border-radius:3px;padding:5px 9px;white-space:nowrap}
#map-shell .cc-surface{min-width:0;overflow:auto;overscroll-behavior:contain;max-height:70vh;min-height:380px;background:linear-gradient(120deg,#26332e,#242e2b);border:1px solid var(--cc-line);border-radius:4px;padding:16px;scrollbar-color:#697865 #25312c}
#map-shell .cc-surface-head{display:flex;align-items:center;gap:12px;margin-bottom:13px;flex-wrap:wrap}
#map-shell .cc-surface-head h2{font:17px "Silkscreen",monospace;color:var(--cc-paper);margin:0}
#map-shell .cc-surface-head p{margin:2px 0 0;color:var(--cc-muted);font-size:12px}
#map-shell .cc-locate{margin-left:auto!important;border:1px solid #7e8060!important;color:#efdbaf!important;max-width:100%}
#map-shell .cc-locate:disabled{opacity:.5;cursor:default}
#map-shell .cc-filter-row{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--cc-line);padding-bottom:10px}
#map-shell .cc-filter-row button{padding:5px 9px}
#map-shell .cc-filter-row button span{margin-left:5px;font-size:11px;color:var(--cc-brass);font-variant-numeric:tabular-nums}
#map-shell .cc-note{font-size:12px;color:var(--cc-muted);margin:10px 0 15px;overflow-wrap:anywhere}
#map-shell .cc-ledger-head,#map-shell .cc-row{display:grid;grid-template-columns:minmax(0,2.4fr) minmax(0,1fr) minmax(0,1.15fr) minmax(0,1fr);gap:16px}
#map-shell .cc-ledger-head{padding:8px 10px;color:var(--cc-brass);font-size:10px;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid #68705a}
#map-shell .cc-row{padding:14px 10px;border-bottom:1px solid #3c4940;border-left:2px solid transparent;align-items:start}
#map-shell .cc-row:hover{background:#2e3a31}
#map-shell .cc-row.cc-selected{border-left-color:var(--cc-brass);background:#364034}
#map-shell .cc-work{display:flex;gap:9px;min-width:0}
#map-shell .cc-work>div{min-width:0}
#map-shell .cc-status{color:#9db39a;font-size:12px;padding-top:3px}
#map-shell .cc-status-blocked{color:#e5b77a}
#map-shell .cc-title{display:block;text-align:left;background:none;border:0;padding:0;color:#f5ebd3!important;font-weight:600!important;line-height:1.45!important;overflow-wrap:anywhere}
#map-shell .cc-title:hover{text-decoration:underline;text-underline-offset:3px}
#map-shell .cc-work p{margin:5px 0 0;color:var(--cc-muted);font-size:12px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
#map-shell .cc-work .cc-input-excerpt{color:#ecd09d}
#map-shell .cc-owner,#map-shell .cc-clocks,#map-shell .cc-delivery{display:flex;flex-direction:column;gap:3px;min-width:0;overflow-wrap:anywhere;font-size:12px}
#map-shell .cc-owner strong{font-weight:500}
#map-shell .cc-owner span,#map-shell .cc-owner small,#map-shell .cc-delivery small{color:var(--cc-muted);font-size:11px}
#map-shell .cc-clocks{font-variant-numeric:tabular-nums}
#map-shell .cc-clocks small{display:inline-block;min-width:58px;color:var(--cc-muted);font-size:10px}
#map-shell .cc-pr{align-self:flex-start;background:#3d4637;border:1px solid #6b7457;color:#e6d5ab!important;border-radius:3px;padding:4px 6px;font-size:11px!important;text-align:left;max-width:100%}
#map-shell .cc-tone-ready,#map-shell .cc-tone-merged{color:#bce2b5!important;border-color:#698961}
#map-shell .cc-tone-blocked{color:#f0c2ab!important;border-color:#926f56}
#map-shell .cc-thread-intro{display:flex;justify-content:space-between;gap:12px;color:var(--cc-brass);font-size:12px;flex-wrap:wrap}
#map-shell .cc-graph-head{position:relative;min-height:15px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--cc-brass);margin:15px 0 0}
#map-shell .cc-graph-head span{position:absolute;top:0}
#map-shell .cc-graph{position:relative;width:100%;overflow:hidden}
#map-shell .cc-graph svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
#map-shell .cc-graph svg path{stroke:#647968;fill:none;stroke-width:1.5}
#map-shell .cc-graph svg path.cc-connected{stroke:#d0b273;stroke-width:2}
#map-shell .cc-graph svg marker path{fill:#cfad70;stroke:none}
#map-shell .cc-node{display:flex;flex-direction:column;align-items:flex-start;text-align:left;border:1px solid #586b5a;background:#2b382e;border-radius:4px;padding:9px 11px;color:var(--cc-paper);text-decoration:none;min-width:0;overflow:hidden;font:inherit;line-height:1.35}
#map-shell .cc-graph .cc-node{position:absolute;height:90px}
#map-shell .cc-node strong{font-size:12px;line-height:1.4;font-weight:550;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
#map-shell .cc-node small{font-size:10px;color:var(--cc-brass);margin-bottom:3px}
#map-shell .cc-node span{font-size:10px;color:var(--cc-muted);margin-top:4px;overflow-wrap:anywhere}
#map-shell .cc-node.cc-selected{border-color:#c0a56b;background:#3a4433}
#map-shell .cc-node-pr{border-style:double;border-width:3px}
#map-shell .cc-node:hover{background:#3b4936}
#map-shell .cc-trace{display:flex;flex-direction:column;gap:10px;max-width:620px;margin:14px auto 0}
#map-shell .cc-trace>label{font-size:12px;color:var(--cc-brass)}
#map-shell .cc-trace select{max-width:100%;width:100%}
#map-shell .cc-trace-edge{padding:12px;border:1px solid #435343;border-radius:4px;display:flex;flex-direction:column;gap:8px}
#map-shell .cc-relation{font-size:11px;color:var(--cc-brass)}
#map-shell .cc-arrow{align-self:center;color:var(--cc-brass)}
#map-shell .cc-trace-details{border-top:1px solid var(--cc-line);margin-top:10px;padding-top:12px}
#map-shell .cc-trace-details summary{cursor:pointer;color:var(--cc-brass);font-size:12px}
#map-shell .cc-empty{padding:40px 16px;text-align:center;color:var(--cc-muted)}
#map-shell .cc-search{background:#27342d;border:1px solid #9b966b;border-radius:7px;box-shadow:0 20px 90px #0009;width:min(620px,calc(100vw - 24px));max-height:80vh;padding:16px;overflow:auto}
#map-shell .cc-search::backdrop{background:#111a18bf;backdrop-filter:blur(3px)}
#map-shell .cc-search-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
#map-shell .cc-search-head label{color:var(--cc-brass);font-size:12px}
#map-shell .cc-search-close{border:1px solid #69775d;border-radius:3px;background:none;padding:3px 8px}
#map-shell .cc-search input{width:100%;padding:12px;margin:10px 0;background:#1d2823;border:1px solid #718466;border-radius:4px;color:var(--cc-paper);font:inherit;box-sizing:border-box}
#map-shell .cc-search-results{display:flex;flex-direction:column;gap:3px}
#map-shell .cc-search-result{padding:10px;border:1px solid transparent;border-radius:3px;background:none;text-align:left;display:flex;flex-direction:column;gap:3px;overflow-wrap:anywhere}
#map-shell .cc-search-result[aria-selected=true]{background:#42513a;border-color:#bba16b}
#map-shell .cc-search-result small{color:var(--cc-muted)}
#map-shell .cc-preview{position:fixed;z-index:500;width:min(330px,calc(100vw - 24px));max-height:50vh;overflow:auto;border:1px solid #a29267;border-radius:5px;padding:12px;background:#253329;box-shadow:0 10px 35px #0007;pointer-events:none}
#map-shell .cc-preview strong,#map-shell .cc-preview span,#map-shell .cc-preview small{display:block}
#map-shell .cc-preview strong{color:#f3dfb4;font-size:12px;margin-bottom:4px}
#map-shell .cc-preview p{font-size:12px;margin:7px 0}
#map-shell .cc-preview small{color:var(--cc-muted);font-size:11px;margin-top:3px}
#map-shell .cc-bar :focus-visible,#map-shell .cc-attention :focus-visible,#map-shell .cc-surface :focus-visible,#map-shell .cc-search :focus-visible{outline:2px solid #efcb7b;outline-offset:3px}
#map-shell[data-command-view=dispatch] .cc-surface,#map-shell[data-command-view=threads] .cc-surface{animation:cc-appear .16s ease-out}
@keyframes cc-appear{from{opacity:.5;transform:translateY(3px)}to{opacity:1;transform:none}}
@media(max-width:1050px){#map-shell .cc-ledger-head,#map-shell .cc-row{grid-template-columns:minmax(0,1.8fr) minmax(0,1fr) minmax(0,1fr)}#map-shell .cc-ledger-head span:last-child{display:none}#map-shell .cc-delivery{grid-column:1/-1;flex-direction:row;align-items:center;gap:12px}#map-shell .cc-delivery small{flex:1}#map-shell .cc-attention-meta{max-width:150px}}
@media(max-width:700px){#map-shell .cc-tools{margin-left:0;width:100%}#map-shell .cc-tools .cc-search-open{margin-left:auto}#map-shell .cc-attention{flex-wrap:wrap;gap:6px 9px}#map-shell .cc-attention-label{flex-basis:100%}#map-shell .cc-attention-meta{max-width:none;flex-basis:100%}#map-shell .cc-surface{padding:12px;max-height:72vh}#map-shell .cc-ledger-head{display:none}#map-shell .cc-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;padding:14px 6px}#map-shell .cc-work{grid-column:1/-1}#map-shell .cc-clocks{font-size:11px}#map-shell .cc-bar .cc-views button{padding:5px 8px}#map-shell .cc-label select{max-width:140px}#map-shell .cc-key{display:none}}
@media(prefers-reduced-motion:reduce){#map-shell .cc-surface{animation:none!important}}

/* Workbenches inhabit the same place. The scene never disappears. */
#tally [data-town-scope]{display:none}
#map-shell .cc-pulse-rail{display:flex;gap:6px;overflow:auto;padding:2px 0 8px;scrollbar-width:thin;scrollbar-color:#65745d transparent;font-family:ui-sans-serif,system-ui}
#map-shell .cc-pulse-rail button{position:relative;flex:0 0 auto;min-width:110px;display:grid;grid-template-columns:22px 1fr;gap:2px 7px;text-align:left;padding:7px 11px;border:1px solid #4c5b4a;border-radius:4px;background:#26352f;color:var(--cc-paper);cursor:pointer}
#map-shell .cc-pulse-rail button[aria-pressed=true]{border-color:#c7ad75;background:#3a4537;box-shadow:inset 0 -2px #c7ad75}
#map-shell .cc-pulse-rail strong{font-size:11px;font-weight:550}
#map-shell .cc-pulse-rail small{grid-column:2;font-size:10px;color:#b2bca9}
#map-shell .cc-heart,#map-shell .cc-pulse-lamps{grid-row:1/3;align-self:center;color:#c4c59a}
#map-shell .cc-pulse-lamps{display:flex;gap:2px;align-items:end;height:18px}
#map-shell .cc-pulse-lamps i{width:3px;height:5px;background:#617263}
#map-shell .cc-pulse-lamps i:nth-child(2),#map-shell .cc-pulse-lamps i:nth-child(4){height:10px}
#map-shell .cc-pulse-lamps i:nth-child(3){height:15px}
#map-shell .cc-pulse-lamps .lit{background:#bfce92;box-shadow:0 0 5px #d7d89133}
#map-shell .cc-alive .cc-pulse-lamps{animation:cc-breathe 3.6s ease-in-out infinite}
#map-shell .cc-faded .cc-pulse-lamps{opacity:.45}
@keyframes cc-breathe{0%,100%{opacity:.55}50%{opacity:1}}
#map-shell .cc-field-guide{font:11px/1.6 ui-sans-serif,system-ui;color:#b4bcac;padding:0 0 7px}
#map-shell .cc-field-guide summary{cursor:pointer;width:fit-content;color:#d0bf92}
#map-shell .cc-field-guide summary span{color:#a3b0a2}
#map-shell .cc-guide-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 20px;background:#27342e;padding:12px 16px;border:1px solid #4e5e4b;margin-top:6px;border-radius:4px}
#map-shell .cc-guide-grid p{margin:0}
#map-shell .cc-guide-grid b{display:block;color:#e7d9b6;font-weight:550}
#map-shell .cc-guide-foot{margin:7px 0 2px;color:#c2c6af}
#map-shell .cc-balance[hidden]{display:none}
#map-shell .cc-balance{display:flex;align-items:center;gap:12px;padding:6px 10px;background:#303b32;border-block:1px solid #677052;color:#dcd3b6;font:11px/1.4 ui-sans-serif,system-ui;min-width:0}
#map-shell .cc-workbench-name{font-weight:650;margin-right:auto}
#map-shell .cc-balance label{display:flex;align-items:center;gap:8px;white-space:nowrap}
#map-shell .cc-balance input{width:110px;accent-color:#d5bd7d;cursor:ew-resize;margin:0}
#map-shell .cc-balance output{font-size:10px;width:58px;font-variant-numeric:tabular-nums}
#map-shell .cc-balance button{background:transparent;border:0;color:#dcd3b6;cursor:pointer;padding:3px 5px}
#map-shell .cc-balance :focus-visible,#map-shell .cc-pulse-rail :focus-visible{outline:2px solid #efcb7b;outline-offset:2px}
#map-shell:not([data-command-view=town]) #perspective-stage{display:grid;height:clamp(400px,calc(100dvh - 360px),880px);grid-template-rows:minmax(0,var(--cc-scene-share,55fr)) auto minmax(0,var(--cc-desk-share,45fr));overflow:hidden;border:1px solid #4d5f50;border-radius:4px}
#map-shell:not([data-command-view=town]) .map-viewport{height:100%;min-height:0;border-radius:0}
#map-shell:not([data-command-view=town]) #command-view{position:relative;inset:auto;min-height:0;max-height:none;border:0;border-radius:0;padding:12px;background:linear-gradient(115deg,#2a382f,#26322d)}
#map-shell.is-fullscreen:not([data-command-view=town]) #perspective-stage{height:auto;min-height:0}
#map-shell.is-fullscreen:not(.details-closed):not([data-command-view=town]) #perspective-stage{margin-right:364px}
#map-shell:not([data-command-view=town]) .cc-surface-head{margin-bottom:6px}
#map-shell:not([data-command-view=town]) .cc-surface-head h2{display:none}
#map-shell:not([data-command-view=town]) .cc-note{margin:6px 0;font-size:11px}
#map-shell:not([data-command-view=town]) .cc-row{padding:10px 8px}
#map-shell:not([data-command-view=town]) .cc-work p{-webkit-line-clamp:2}
@media(max-width:700px){#map-shell .cc-workbench-name{font-size:10px}#map-shell .cc-balance{gap:5px;padding:6px}#map-shell .cc-balance label{font-size:9px;gap:3px}#map-shell .cc-balance input{width:75px}#map-shell .cc-balance output{width:49px}#map-shell .cc-balance button span{display:none}#map-shell .cc-guide-grid{grid-template-columns:1fr}#map-shell:not([data-command-view=town]) #perspective-stage{height:660px}}
@media(max-width:600px){#map-shell.is-fullscreen:not(.details-closed):not([data-command-view=town]) #perspective-stage{margin-right:0}#map-shell.is-fullscreen:not(.details-closed):not([data-command-view=town]) .details-shell{top:auto;bottom:12px;max-height:45dvh}}
@media(prefers-reduced-motion:reduce){#map-shell .cc-alive .cc-pulse-lamps{animation:none}}
#map-shell .cc-trades{margin:4px 0;color:#e4dfc2;border:1px solid #657762;border-radius:8px;background:#283b33;font-size:11px}
#map-shell .cc-trades summary{cursor:pointer;padding:7px 10px;min-height:28px;line-height:1.5}
#map-shell .cc-trades summary span{margin-left:8px;color:#bcc9a8;font-size:10px}
#map-shell .cc-trade-body{padding:0 10px 9px;max-height:260px;overflow:auto}
#map-shell .cc-trade-stories{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0}
#map-shell .cc-trades button{border:1px solid #718369;border-radius:5px;background:#354b3c;color:#efead1;padding:6px 8px;font:inherit;cursor:pointer}
#map-shell .cc-trades button[aria-pressed=true]{background:#5b714f;border-color:#c4c798}
#map-shell .cc-trades button:focus-visible,#map-shell .cc-trades summary:focus-visible{outline:2px solid #efd397;outline-offset:2px}
#map-shell .cc-trade-story{border-left:2px solid #b5bb83;padding:5px 9px;margin:7px 0;line-height:1.5}
#map-shell .cc-trade-story p{margin:4px 0;overflow-wrap:anywhere}
`;
