import {openSession,masterDir} from '../../dist/browser/chrome.js';
import {mkdirSync,writeFileSync} from 'node:fs';
const dir='C:/ProgramData/HELM/logs/chatgpt-direct-otp';
mkdirSync(dir,{recursive:true});
let s;
const result={stage:'opening',signedIn:null,pathname:null,buttons:[],inputs:[],humanCheck:false};
try{
  s=await openSession({master:masterDir(),artifactsDir:dir});
  s.touched.add('chatgpt');
  const p=s.page;
  await p.goto('https://chatgpt.com/auth/login',{waitUntil:'domcontentloaded',timeout:45000});
  await p.waitForTimeout(3500);
  result.pathname=new URL(p.url()).pathname;
  result.buttons=await p.locator('button,[role=button]').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0).map(e=>(e.getAttribute('aria-label')||e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80)).filter(Boolean).slice(0,25));
  result.inputs=await p.locator('input').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0).map(e=>({type:e.type,name:e.name||'',placeholder:e.placeholder||''})).slice(0,10));
  result.humanCheck=/verify you are human|just a moment|captcha/i.test(await p.title());
  result.stage='surveyed';
}catch(err){
 result.stage='error'; result.reason=String(err?.message||err).split('\\n')[0].slice(0,250);
 if(s) try{const file=dir+'/login-read-error.png';await s.page.screenshot({path:file}); result.screenshot=file}catch{}
}finally{if(s)await s.close().catch(()=>{});}
console.log(JSON.stringify(result,null,2));
