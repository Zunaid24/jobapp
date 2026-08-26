import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { planDailyJobSearch, rankNewJobs } from "@/lib/gemini-job-controller";

const ACTOR_ID = process.env.APIFY_ACTOR_ID || "curious_coder/linkedin-jobs-scraper";
const HR_JOB_TITLE = /\b(?:hr|human resources|recruit(?:er|ment)?|talent acquisition|talent management|people operations|people ops|people partner|staffing|resourcing)\b/i;
const HR_ROLE_SIGNAL = /\b(?:executive|coordinator|associate|specialist|generalist|recruiter|recruitment|talent acquisition|human resources|hr|people operations|people ops|hr operations|hr admin|hr administrator)\b/i;
const EXCLUDED_TITLE = /\b(?:software|developer|engineer|designer|accountant|accounting|sales|marketing|finance|legal|chef|cook|waiter|nurse|doctor|driver|technician|mechanic|electrician|security guard|housekeeping|front office|customer service)\b/i;
const DEFAULT_INPUT = { keywords: "HR Executive OR HR Coordinator OR HR Recruiter OR Talent Acquisition", location: "Goa", datePosted: "past24Hours", limitPerSource: 12, scrapeCompany: false, scrapeJobDetails: false, scrapeSkills: false };
type ApifyJob = Record<string, unknown>;
function required(name:string){const value=process.env[name];if(!value)throw new Error(`Missing environment variable: ${name}`);return value;}
function text(...values:unknown[]){return values.find(v=>typeof v==="string"&&v.trim())?.toString().trim()||"";}
function isGoa(job:ApifyJob){return /\b(goa|panaji|panjim|margao|vasco da gama|mapusa)\b/i.test(text(job.location,job.jobLocation,job.city,job.title));}
function isRelevantHrRole(title:string,description:string){if(!title.trim()||EXCLUDED_TITLE.test(title))return false;if(HR_JOB_TITLE.test(title))return true;return /\b(?:executive|coordinator|associate|specialist|generalist)\b/i.test(title)&&HR_ROLE_SIGNAL.test(description);}
function nestedCompanyValue(job:ApifyJob,...keys:string[]){const company=job.company;if(!company||typeof company!=="object"||Array.isArray(company))return "";const record=company as Record<string,unknown>;return text(...keys.map(k=>record[k]));}
function normalize(job:ApifyJob){
 const title=text(job.title,job.jobTitle,job.position),company=text(job.company,job.companyName,job.organization,nestedCompanyValue(job,"name","companyName")),location=text(job.location,job.jobLocation,job.city,job.workplaceType),description=text(job.description,job.summary,job.jobDescription,job.descriptionText),url=text(job.applyUrl,job.apply_url,job.jobUrl,job.url,job.link),posted=text(job.posted_date,job.postedDate,job.datePosted,job.createdAt);
 if(!title||!company||!isGoa(job)||!isRelevantHrRole(title,description))return null;
 const parsed=posted?new Date(posted):null;if(parsed&&!Number.isNaN(parsed.getTime())){const age=(Date.now()-parsed.getTime())/86400000;if(age< -0.5||age>1)return null;}
 const fingerprint=text(job.id,job.jobId,url)||`${title}|${company}|${location}`,id=createHash("sha256").update(fingerprint.toLowerCase()).digest("hex").slice(0,32);
 return {id,title,company,location:"Goa",type:text(job.type,job.jobType,job.employmentType)||"Full-time",match_score:HR_JOB_TITLE.test(title)?100:85,description:description.slice(0,30000),apply_url:url||null,contact_email:null,decision_maker_name:null,decision_maker_title:null,source:text(job.source,job.platform)||"Apify",posted_at:parsed&&!Number.isNaN(parsed.getTime())?parsed.toISOString():null,company_website:null,company_domain:null,company_linkedin_url:null,company_location:null,company_industry:null,raw:job};
}
function db(){return createClient(required("NEXT_PUBLIC_SUPABASE_URL"),required("SUPABASE_SERVICE_ROLE_KEY"),{auth:{autoRefreshToken:false,persistSession:false}});}
async function runActor(input:Record<string,unknown>){const token=required("APIFY_API_TOKEN");const maxCharge=process.env.APIFY_DAILY_MAX_CHARGE_USD||"0.016";const response=await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?maxItems=15&maxTotalChargeUsd=${encodeURIComponent(maxCharge)}`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(input),cache:"no-store"});if(!response.ok)throw new Error(`Apify Actor failed (${response.status}): ${(await response.text()).slice(0,500)}`);const data=await response.json();return Array.isArray(data)?data as ApifyJob[]:[];}

export async function refreshDailyJobs(options:{force?:boolean}={}){
 const client=db(),today=new Date().toISOString().slice(0,10);
 if(options.force){const {error}=await client.from("job_collection_runs").delete().eq("collection_date",today);if(error)throw new Error(`Unable to reset daily job collection: ${error.message}`);}
 const {data:claimed,error:claimError}=await client.rpc("claim_daily_job_collection",{p_collection_date:today});if(claimError)throw new Error(`Unable to claim daily job collection: ${claimError.message}`);if(!claimed){const {count}=await client.from("jobs").select("id",{count:"exact",head:true}).eq("collected_on",today);return {skipped:true,itemCount:count??0};}
 try{
  const plan=await planDailyJobSearch();
  const {data:history,error:historyError}=await client.from("jobs").select("id,title,company,location,apply_url").order("collected_on",{ascending:false}).limit(1000);
  if(historyError)throw new Error(`Unable to load job history: ${historyError.message}`);
  const historyKeys=new Set((history||[]).map(j=>`${String(j.title||"").trim().toLowerCase()}|${String(j.company||"").trim().toLowerCase()}|${String(j.location||"").trim().toLowerCase()}`));
  let input:Record<string,unknown>={...DEFAULT_INPUT,limitPerSource:Math.min(12,Math.max(5,plan.maxResults)),keywords:plan.roleQueries.join(" OR ")};
  if(process.env.APIFY_INPUT_JSON)input={...input,...JSON.parse(process.env.APIFY_INPUT_JSON) as Record<string,unknown>};
  input.keywords=plan.roleQueries.join(" OR ");input.location="Goa";input.datePosted="past24Hours";input.limitPerSource=Math.min(12,Math.max(5,plan.maxResults));input.scrapeCompany=false;input.scrapeJobDetails=false;input.scrapeSkills=false;

  const items=await runActor(input);
  const normalized=items.map(normalize).filter((x):x is NonNullable<ReturnType<typeof normalize>>=>Boolean(x));
  const newJobs=Array.from(new Map(normalized.filter(j=>!historyKeys.has(`${j.title.toLowerCase()}|${j.company.toLowerCase()}|${j.location.toLowerCase()}`)).map(j=>[j.id,j])).values()).slice(0,50);
  const ranked=await rankNewJobs(newJobs);
  const rankMap=new Map(ranked.map(r=>[r.id,r]));
  const selected=newJobs.filter(j=>{const r=rankMap.get(j.id);return r?.decision==="KEEP"&&r.score>=70;}).sort((a,b)=>(rankMap.get(b.id)?.score||0)-(rankMap.get(a.id)?.score||0)).slice(0,10);
  const selectedWithScores=selected.map(job=>({...job,match_score:rankMap.get(job.id)?.score||job.match_score}));
  if(selectedWithScores.length){const rows=selectedWithScores.map(job=>({id:job.id,title:job.title,company:job.company,location:job.location,type:job.type,match_score:job.match_score,description:job.description,apply_url:job.apply_url,contact_email:null,decision_maker_name:null,decision_maker_title:null,source:job.source,posted_at:job.posted_at,collected_on:today,raw:job.raw}));const {error}=await client.from("jobs").upsert(rows,{onConflict:"id"});if(error)throw new Error(`Unable to store jobs: ${error.message}`);}
  const companies=new Set(selectedWithScores.map(j=>j.company.toLowerCase())).size;
  await client.from("job_collection_runs").update({status:"completed",item_count:selectedWithScores.length,completed_at:new Date().toISOString(),error:null,updated_at:new Date().toISOString()}).eq("collection_date",today);
  return {skipped:false,itemCount:selectedWithScores.length,goaCount:selectedWithScores.length,companies,decisionMakers:0,previouslySeen:historyKeys.size,apifyCandidates:normalized.length,aiAccepted:selectedWithScores.length,aiModel:process.env.GEMINI_JOB_MODEL||"gemini-2.5-flash-lite"};
 }catch(error){await client.from("job_collection_runs").update({status:"failed",error:error instanceof Error?error.message:"Unknown error",updated_at:new Date().toISOString()}).eq("collection_date",today);throw error;}
}
