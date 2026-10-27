import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {S3Client,GetObjectCommand,CopyObjectCommand,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {bookkeepingStorageConfig,bookkeepingStorageErrorMessage,storageCopySource} from './bookkeeping-storage.js';

const env = {BUCKET:'bookkeeping-test-suffix',ENDPOINT:'https://t3.storageapi.dev',REGION:'auto',
  ACCESS_KEY_ID:'test-access-key',SECRET_ACCESS_KEY:'test-secret-key'};

test('Railway S3 bucket names take precedence over display names; both credential variable formats work',()=>{
  const direct=bookkeepingStorageConfig({...env,RAILWAY_BUCKET_NAME:'Display name'});
  assert.equal(direct.bucket,env.BUCKET);assert.equal(direct.options.forcePathStyle,false);
  const legacy=bookkeepingStorageConfig({RAILWAY_BUCKET_NAME:env.BUCKET,RAILWAY_BUCKET_ENDPOINT:env.ENDPOINT,
    RAILWAY_BUCKET_REGION:env.REGION,RAILWAY_BUCKET_ACCESS_KEY:env.ACCESS_KEY_ID,RAILWAY_BUCKET_SECRET_KEY:env.SECRET_ACCESS_KEY});
  assert.deepEqual(legacy.options,direct.options);assert.equal(legacy.bucket,direct.bucket);
  assert.equal(bookkeepingStorageConfig({...env,RAILWAY_BUCKET:'explicit-bucket'}).bucket,'explicit-bucket');
});

test('whitespace is trimmed and both virtual-hosted and legacy path-style requests are signed correctly offline',async()=>{
  const padded=Object.fromEntries(Object.entries(env).map(([key,value])=>[key,` ${value}\n`]));
  assert.deepEqual(bookkeepingStorageConfig(padded),bookkeepingStorageConfig(env));
  for(const pathStyle of [false,true]) {
    const config=bookkeepingStorageConfig({...padded,RAILWAY_BUCKET_FORCE_PATH_STYLE:String(pathStyle)});
    const client=new S3Client(config.options);
    try {
      const signed=new URL(await getSignedUrl(client,new GetObjectCommand({Bucket:config.bucket,Key:'bookkeeping/receipt 1.pdf'}),
        {expiresIn:60,signingDate:new Date('2026-10-27T12:00:00Z')}));
      assert.equal(signed.hostname,pathStyle?'t3.storageapi.dev':`${env.BUCKET}.t3.storageapi.dev`);
      assert.equal(signed.pathname,pathStyle?`/${env.BUCKET}/bookkeeping/receipt%201.pdf`:'/bookkeeping/receipt%201.pdf');
      assert.match(signed.searchParams.get('X-Amz-Credential'),/\/auto\/s3\/aws4_request$/);
      assert.ok(signed.searchParams.get('X-Amz-Signature'));
    } finally {client.destroy();}
  }
  assert.equal(bookkeepingStorageConfig({...env,ENDPOINT:'https://legacy.example'}).options.forcePathStyle,true);
});

test('invalid configuration produces actionable messages without exposing credentials',()=>{
  for(const change of [{ENDPOINT:'not a url'},{ENDPOINT:'https://t3.storageapi.dev/bucket'},
    {ENDPOINT:'https://user:password@t3.storageapi.dev'},{RAILWAY_BUCKET_FORCE_PATH_STYLE:'maybe'},{SECRET_ACCESS_KEY:''}]) {
    const result=bookkeepingStorageConfig({...env,...change});
    assert.equal(result.options,null);assert.ok(result.error);assert.doesNotMatch(result.error,/test-secret-key|password@/);
  }
});

test('copy source paths encode filenames without changing their object-key meaning',()=>{
  const key='bookkeeping/receipt #1 + tax%/café.pdf';
  const encoded=storageCopySource(env.BUCKET,key);
  assert.equal(decodeURIComponent(encoded),`${env.BUCKET}/${key}`);
  assert.match(encoded,/%23/);assert.match(encoded,/%2B/);assert.match(encoded,/%25/);
});

test('signature diagnostics distinguish download failures from post-extraction copy failures',()=>{
  const error=Object.assign(new Error('The request signature we calculated does not match the signature you provided. Sensitive provider details.'),{name:'SignatureDoesNotMatch'});
  assert.match(bookkeepingStorageErrorMessage(error,'download'),/downloading the document for AI/);
  assert.match(bookkeepingStorageErrorMessage(error,'copy'),/after AI extraction/);
  assert.doesNotMatch(bookkeepingStorageErrorMessage(error,'download'),/Sensitive provider details/);
  assert.equal(bookkeepingStorageErrorMessage(new Error('Object not found'),'download'),'Object not found');
});

test('queue failures preserve the failed document, identify the storage operation, and do not save partial extraction',async()=>{
  const source=readFileSync(new URL('./bookkeeping.js',import.meta.url),'utf8');
  const registration=source.slice(source.indexOf('export function registerBookkeepingRoutes')).replace('export function','function');
  for(const failure of ['download','copy']) {
    const routes=new Map(),queries=[],logs=[];let aiCalls=0,failedMessage;
    const document={id:1,storage_key:'bookkeeping/1-upload.pdf',original_filename:'upload.pdf',mime_type:'application/pdf',processing_status:'queued',metadata:{}};
    const query=async(sql,values)=>{
      queries.push(sql);
      if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
      if(sql.startsWith('SELECT * FROM bookkeeping_documents'))return {rows:[document],rowCount:1};
      if(sql.startsWith("UPDATE bookkeeping_documents SET processing_status='processing'"))return {rows:[{id:1}],rowCount:1};
      if(sql.includes("processing_status='failed'"))failedMessage=values[1];
      return {rows:[],rowCount:0};
    };
    const pool={query,connect:async()=>({query,release(){}})};
    const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,...handlers)=>routes.set(`${method} ${path}`,handlers.at(-1))]));
    const context=vm.createContext({Buffer,process:{env:{}},bookkeepingRoutes:()=>app,
      bookkeepingStorageConfig:()=>bookkeepingStorageConfig(env),bookkeepingStorageErrorMessage,storageCopySource,
      upload:{single:()=>()=>{}},GetObjectCommand,CopyObjectCommand,PutObjectCommand,DeleteObjectCommand,
      setInterval:()=>({unref(){}}),console:{warn:(...args)=>logs.push(args)},
      safeFilenamePart:(value,fallback)=>value||fallback,
      extractDocument:async()=>{aiCalls++;return {documentType:'receipt',transactions:[]};},
      S3Client:class {async send(command){
        if(failure==='download'||command instanceof CopyObjectCommand)throw Object.assign(new Error('Provider signature mismatch'),{name:'SignatureDoesNotMatch',$metadata:{httpStatusCode:403,requestId:'test-request'}});
        return {Body:(async function*(){yield Buffer.from('test document');})()};
      }}
    });
    vm.runInContext(`${registration}\nthis.register=registerBookkeepingRoutes;`,context);
    context.register(app,{pool});
    const res={status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
    await routes.get('post /api/bookkeeping/documents/:id/process')({params:{id:1},body:{},adminUser:{id:2}},res);
    assert.equal(res.statusCode,500);assert.equal(res.body.message,failedMessage);
    assert.match(failedMessage,failure==='download'?/downloading/:/renaming/);
    assert.equal(aiCalls,failure==='download'?0:1);
    assert.equal(logs[0][1].operation,failure);assert.equal(logs[0][1].requestId,'test-request');
    assert.equal(queries.some(sql=>sql.startsWith('INSERT INTO bookkeeping_extractions')),false);
    assert.equal(queries.some(sql=>sql.startsWith('DELETE FROM bookkeeping_documents')),false);
  }
});
