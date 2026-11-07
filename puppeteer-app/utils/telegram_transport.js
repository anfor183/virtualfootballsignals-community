'use strict';
const https=require('https');
let queue=Promise.resolve();
// Telegram explicitly rejected a 429 request, so retrying that request is safe.
// A timeout/reset may follow a successful send: never automatically resend it.
function requestOnce(token,method,payload){return new Promise(resolve=>{
    const body=JSON.stringify(payload);let finished=false;
    const finish=value=>{if(!finished){finished=true;resolve(value);}};
    try{
        const req=https.request({hostname:'api.telegram.org',path:`/bot${token}/${method}`,method:'POST',family:4,
            headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:15000},res=>{
            let data='';res.on('data',chunk=>data+=chunk);res.on('error',()=>finish({ok:false,uncertain:true,description:'Response interrupted'}));
            res.on('end',()=>{try{const result=JSON.parse(data);finish(result);}catch{finish({ok:false,uncertain:true,description:'Invalid Telegram response'});}});
        });
        req.on('error',()=>finish({ok:false,uncertain:true,description:'Connection interrupted; delivery status unknown'}));
        req.on('timeout',()=>{finish({ok:false,uncertain:true,description:'Delivery status unknown after timeout'});req.destroy();});
        req.end(body);
    }catch{finish({ok:false,uncertain:true,description:'Request failed; delivery status unknown'});}
});}
async function call(token,method,payload){
    if(!token||!payload.chat_id||!payload.text)return {ok:false,description:'Missing Telegram destination or content'};
    const work=async()=>{
        let result;for(let attempt=0;attempt<3;attempt++){
            result=await requestOnce(token,method,payload);
            if(result.error_code!==429)break;
            if(attempt<2)await new Promise(r=>setTimeout(r,(Math.max(1,Number(result.parameters?.retry_after)||5)+1)*1000));
        }
        if(method==='editMessageText'&&result.error_code===400&&/message is not modified/i.test(result.description||''))result={ok:true,unchanged:true};
        await new Promise(r=>setTimeout(r,100));return result;
    };
    const result=queue.then(work,work);queue=result.catch(()=>{});return result;
}
const send=(token,chat,text,parseMode='HTML')=>call(token,'sendMessage',{chat_id:chat,text,parse_mode:parseMode,link_preview_options:{is_disabled:true}});
const edit=(token,chat,messageId,text)=>call(token,'editMessageText',{chat_id:chat,message_id:messageId,text,parse_mode:'HTML',link_preview_options:{is_disabled:true}});
module.exports={send,edit};
