/**
 * The browser-diagnostics collector bundle (docs/design/diagnostics.md),
 * served as plain JS from `/widget-diagnostics.js` and loaded by the widget
 * loader ONLY when the Product has diagnostics enabled. Budget: <= 4 KB
 * gzip (DX-17); the source is written compactly to stay inside it.
 *
 * Constraints enforced by tests:
 *  - The static ban gate (DX-05) scans the shipped source for banned
 *    identifiers (storage, headers, bodies, serialisation, low-level console
 *    hooks). Do not add them, not even in comments.
 *  - The parity test (DX-06) runs the fixture corpus through `redactText`
 *    below and through `src/lib/diagnostics/redact.ts`, requiring identical
 *    output. Change both together.
 *
 * Plain ES5-style JS like the loader: no template literals, no backticks, no
 * dollar-brace sequences (String.raw keeps regex backslashes intact).
 */

export const COLLECTOR_JS = String.raw`
(function (global) {

 var URL_RE=/https?:\/\/[^\s"'\x60<>]+/g, EMAIL_RE=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  EMAIL_TEST=/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, JWT_RE=/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  AUTH=/(\bAuthorization\s*:\s*\S+(?:\s+[A-Za-z0-9._~+/=-]+)?|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+)/gi,
  CARD=/(?:\d[ -]?){12,18}\d/g, HEX=/(?<![0-9A-Za-z_-])[0-9A-Fa-f]{32,}(?![0-9A-Za-z_-])/g, AWS=/\bAKIA[0-9A-Z]{16}\b/g, MIXED=/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g,
  UUID=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  KK=/(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})(\s*[:=]\s*)/g, KV=/^("[^"]*"|'[^']*'|\[[^\]\s]*\]?|[^\s,;{}[\]"']+)/,
  JKV=/"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"([^"]*)"/g, CTRL=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
  SENS=/(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|session|cookie|card|cvv|cvc|iban|ssn)/i;
 function luhn(d){var s=0,x=false;for(var i=d.length-1;i>=0;i--){var v=d.charCodeAt(i)-48;if(x){v*=2;if(v>9)v-=9;}s+=v;x=!x;}return s%10===0;}
 function hot(v){return /^[0-9A-Fa-f]{32,}$/.test(v)||(v.length>=24&&/[A-Za-z]/.test(v)&&/\d/.test(v));}
 function shrink(u){try{var p=new URL(u);return p.origin+p.pathname;}catch(e){return u;}}
 function scrub(u){
  var s=u.indexOf('://');if(s===-1)return u;
  var p=u.indexOf('/',s+3);if(p===-1)return u;
  var head=u.slice(0,p),seg=u.slice(p).split('/');
  for(var i=0;i<seg.length;i++){var g=seg[i];if(!g)continue;
   if(EMAIL_TEST.test(g)){seg[i]='[email]';continue;}
   if(UUID.test(g)||hot(g))seg[i]='[token]';}
  return head+seg.join('/');
 }
 function rt(s,n){return redactText(String(s||'')).slice(0,n);}
 function kvPass(t){
  var out='',copied=0,m;
  KK.lastIndex=0;
  while((m=KK.exec(t))!==null){
   if(!SENS.test(m[1]))continue;
   var vs=m.index+m[0].length;
   var v=KV.exec(t.slice(vs));
   out+=t.slice(copied,m.index)+m[1]+m[2]+'[redacted]';
   copied=vs+(v?v[0].length:0);
  }
  return copied===0?t:out+t.slice(copied);
 }
 function redactText(t){
  t=String(t).replace(URL_RE,shrink).replace(AUTH,'Bearer [redacted]').replace(JWT_RE,'[token]');
  t=t.replace(JKV,function(w,k,s){return SENS.test(k)?'"'+k+'"'+s+'"[redacted]"':w;});
  t=kvPass(t);
  t=t.replace(EMAIL_RE,'[email]').replace(CARD,function(c){var d=c.replace(/\D/g,'');return d.length>=13&&d.length<=19&&luhn(d)?'[card]':c;})
      .replace(HEX,'[token]').replace(AWS,'[token]').replace(MIXED,function(c){return /[A-Za-z]/.test(c)&&/\d/.test(c)?'[token]':c;})
   .replace(URL_RE,scrub);
  return t.replace(CTRL,'');
 }
 var F2=/^(.*):(\d+):(\d+)$/;
 function frame(line){
  var r=line,fn='',loc='';
  var a=/^at\s+/.exec(r);if(a)r=r.slice(a[0].length);
  var o=r.lastIndexOf('('),c=r.lastIndexOf(')');
  if(o!==-1&&c>o){fn=r.slice(0,o).trim();loc=r.slice(o+1,c);}
  else if((o=r.indexOf('@'))!==-1){fn=r.slice(0,o).trim();loc=r.slice(o+1);}
  else loc=r;
  var m=F2.exec(loc);
  return {fn:rt(fn,100),file:rt(m?m[1]:loc,300),line:m?+m[2]||0:0,col:m&&m[3]?+m[3]||0:0};
 }
 function parseStack(st){
  var out=[],ls=String(st||'').split('\n');
  for(var i=0;i<ls.length&&out.length<20;i++){
   var l=ls[i].trim();
   if(l&&/^at\s|@/.test(l))out.push(frame(l));
  }
  return out;
 }
 function est(s){var n=2;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);n+=c===34||c===92?2:1;}return n;}
 function estEv(e){
  var t=128,ks=['name','message','pagePath','method','url'],i;
  for(i=0;i<ks.length;i++)if(typeof e[ks[i]]==='string')t+=est(e[ks[i]]);
  if(e.frames)for(i=0;i<e.frames.length;i++)t+=est(e.frames[i].fn)+est(e.frames[i].file);
  return t;
 }
 var LIMIT=50, WIN=1800000, EST_MAX=24576;
 function key(e){
  var top=e.frames&&e.frames.length?e.frames[0].file+':'+e.frames[0].line:'';
  if(e.kind==='network')return 'n|'+e.method+'|'+e.url+'|'+e.status;
  return e.kind+'|'+(e.message||'')+'|'+top;
 }
  function createBuffer(limit){
   limit=limit||LIMIT;
   var evs=[],dropped=0,sent=0,prev=0;
  return {
   push:function(e){
    var k=key(e),i;
    for(i=evs.length-1;i>=sent;i--)if(evs[i].key===k){evs[i].count++;evs[i].lastSeen=e.lastSeen;return;}
    e.key=k;evs.push(e);
    if(evs.length>limit){evs.shift();dropped++;if(sent>0)sent--;}
   },
   unsent:function(now){
    var out=[];
    for(var i=sent;i<evs.length;i++){if(now-evs[i].lastSeen<=WIN)out.push(evs[i]);else dropped++;}
    return out;
   },
   markAllSent:function(kept){if(kept)prev=sent;sent=evs.length;},
   restore:function(){sent=prev;},
   takeDropped:function(){var d=dropped;dropped=0;return d;},
   clear:function(){evs=[];sent=0;prev=0;},
   size:function(){return evs.length;}
  };
 }
 var EK=['name','message','frames','pagePath','method','url','status'];
 function createCollector(opts){
  var w=opts.window,so=opts.serviceOrigin||'',buf=createBuffer(LIMIT),paused=!!opts.startPaused,dead=false;
  function fail(){dead=true;}
  function path(){try{return rt(w.location.pathname,300);}catch(e){return '';}}
  function rec(e){if(dead||paused)return;var n=Date.now();e.firstSeen=n;e.lastSeen=n;e.count=1;try{buf.push(e);}catch(x){fail(x);}}
  function recErr(kind,name,msg,stack){
   rec({kind:kind,name:rt(name,200)||'Error',message:rt(msg,500),
    frames:parseStack(stack),pagePath:path()});
  }
  function recNet(method,url,status){
   rec({kind:'network',method:String(method||'GET').toUpperCase().slice(0,10),url:rt(url,300),status:status|0});
  }
  function svc(u){if(!so)return false;try{return new URL(u,w.location.href).origin===so;}catch(e){return false;}}
  function abort(e){return !!(e&&typeof e==='object'&&e.name==='AbortError');}
  function mark(f){try{Object.defineProperty(f,'__ss',{value:true});}catch(e){}}
  function install(){
   try{
    w.addEventListener('error',function(ev){
     try{
      if(ev.target&&ev.target!==w)return;
      var e=ev.error;
      if(e&&typeof e==='object')recErr('js_error',e.name,e.message,e.stack);
      else recErr('js_error','Error',ev.message,'at '+(ev.filename||'')+':'+(ev.lineno||0)+':'+(ev.colno||0));
     }catch(x){fail(x);}
    });
    w.addEventListener('unhandledrejection',function(ev){
     try{
      var r=ev.reason;
      if(r&&typeof r==='object'&&typeof r.message==='string')recErr('promise_rejection',r.name||'UnhandledRejection',r.message,r.stack);
      else recErr('promise_rejection','UnhandledRejection',typeof r==='string'?r:'[non-error rejection: '+typeof r+']','');
     }catch(x){fail(x);}
    });
    var con=w.console;
    if(con)['warn','error'].forEach(function(lv){
     var o=con[lv];if(typeof o!=='function'||o.__ss)return;
     var f=function(){
      try{
       if(!dead&&!paused){
        var p=[];
        for(var i=0;i<arguments.length&&i<5;i++){
         var a=arguments[i];
         p.push(typeof a==='string'||typeof a==='number'||typeof a==='boolean'?String(a):a&&typeof a==='object'&&typeof a.name==='string'&&typeof a.message==='string'?a.name+': '+a.message:'[object]');
        }
        rec({kind:'warning',message:rt(p.join(' '),500)});
       }
      }catch(x){fail(x);}
      return o.apply(con,arguments);
     };
     mark(f);con[lv]=f;
    });
    function note(m,u,s){try{if(u&&!svc(u))recNet(m,u,s);}catch(x){fail(x);}}
     var of=w.fetch;
     if(typeof of==='function'&&!of.__ss){
      var wf=function(){
       var m='GET',u='',i=arguments[0],n=arguments[1];
       try{u=typeof i==='string'?i:i&&i.url||'';m=n&&n.method||i&&i.method||'GET';}catch(e){}
       var p;
       try{p=of.apply(this,arguments);}
       catch(err){if(!abort(err))note(m,u,0);throw err;}
       return p.then(function(r){try{if(r.type!=='opaque'&&(r.status===0||r.status>=400))note(m,u,r.status);}catch(x){fail(x);}return r;},
        function(err){if(!abort(err))note(m,u,0);throw err;});
      };
      mark(wf);w.fetch=wf;
     }
     var xp=w.XMLHttpRequest&&w.XMLHttpRequest.prototype;
     if(xp&&xp.open&&xp.send&&!xp.open.__ss){
      var oo=xp.open,os=xp.send;
      var wo=function(m,u){try{this.__sm=String(m||'GET');this.__su=String(u||'');}catch(e){}return oo.apply(this,arguments);};
      var ws=function(){
       try{
        var x=this,u=x.__su;
        if(u&&!svc(u)){
         x.addEventListener('abort',function(){x.__sa=1;});
         x.addEventListener('loadend',function(){
          try{var s=x.status;if(!x.__sa&&(s===0||s>=400))recNet(x.__sm,u,s);}catch(e){fail(e);}
         });
        }
       }catch(e){}
       return os.apply(this,arguments);
      };
      mark(wo);mark(ws);xp.open=wo;xp.send=ws;
     }
   }catch(e){fail(e);}
  }
  install();
  return {
    snapshot:function(){
     if(dead||paused)return null;
     try{
      var now=Date.now(),evs=buf.unsent(now),dropped=buf.takeDropped(),size=0,i;
      for(i=0;i<evs.length;i++)size+=estEv(evs[i]);
      while(evs.length>0&&size>EST_MAX){size-=estEv(evs[0]);evs.shift();dropped++;}
      buf.markAllSent(evs.length>0);
      if(evs.length===0)return null;
      var l=w.location;
      return {
       schemaVersion:1,
       environment:{pageUrl:rt(l.origin+l.pathname,300),viewportWidth:w.innerWidth|0,
        viewportHeight:w.innerHeight|0,devicePixelRatio:w.devicePixelRatio||1},
       events:evs.map(function(e){
        var o={kind:e.kind,firstSeen:e.firstSeen,lastSeen:e.lastSeen,count:e.count};
        for(var j=0;j<EK.length;j++)if(e[EK[j]]!==undefined)o[EK[j]]=e[EK[j]];
        return o;
       }),
       droppedCount:dropped
      };
     }catch(e){fail(e);return null;}
    },
    restore:function(){try{buf.restore();}catch(e){fail(e);}},
    pause:function(){paused=true;buf.clear();},
    resume:function(){paused=false;}
   };
 }
 function autoStart(){
  if(global.__ssDiag)return global.__ssDiag;
  var s=global.document&&global.document.currentScript,so='';
  try{so=(s&&s.getAttribute('data-service-origin'))||(global.__ssDiagConfig&&global.__ssDiagConfig.serviceOrigin)||'';}catch(e){}
  global.__ssDiag=createCollector({window:global,serviceOrigin:so,
   startPaused:!!(global.__ssDiagConfig&&global.__ssDiagConfig.startPaused)});
  return global.__ssDiag;
 }
  if(typeof document!=='undefined'&&document&&document.createElement){
   autoStart();
  } else if(typeof module!=='undefined'&&module.exports){
   module.exports={redactText,parseStack,estimateEvent:estEv,createBuffer,createCollector,
    LIMITS:{BUFFER_LIMIT:LIMIT,WINDOW_MS:WIN}};
  }
 })(typeof window!=='undefined'?window:globalThis);
`;
