import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { findHrContacts, resolveCompanyLinkedIn } from "@/lib/contact-actors";

function db(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error("Supabase configuration is missing");return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});}
export const dynamic="force-dynamic";
export const maxDuration=300;

const CACHE_HOURS=Number(process.env.HR_CONTACT_CACHE_HOURS||24);
const DAILY_LIMIT=Number(process.env.DAILY_HR_ENRICHMENT_LIMIT||3);

export async function POST(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params; const client=db();
  const {data:job,error}=await client.from("jobs").select("id,title,company,location,type,description,apply_url,posted_at,company_id").eq("id",id).maybeSingle();
  if(error)throw error;if(!job)return NextResponse.json({error:"Job not found"},{status:404});
  if(!job.company_id)return NextResponse.json({error:"This job has no company record"},{status:422});
  const {data:company}=await client.from("companies").select("id,name,website,domain,linkedin_url,location,industry,description").eq("id",job.company_id).maybeSingle();
  if(!company)return NextResponse.json({error:"Company not found"},{status:422});

  const cacheSince=new Date(Date.now()-CACHE_HOURS*60*60*1000).toISOString();
  const {data:cached}=await client.from("decision_makers").select("name,title,email,linkedin_url,company,raw,last_enriched_at").eq("company_id",company.id).gte("last_enriched_at",cacheSince).order("last_enriched_at",{ascending:false}).limit(10);
  if(cached?.length){
    return NextResponse.json({job,company:{...company,linkedin_url:company.linkedin_url||null},decisionMakers:cached,source:"cache"});
  }

  const {data:recentRows}=await client.from("decision_makers").select("company_id,last_enriched_at").gte("last_enriched_at",new Date(Date.now()-24*60*60*1000).toISOString()).limit(1000);
  const recentlyEnriched=new Set((recentRows||[]).map(row=>row.company_id).filter(Boolean));
  if(recentlyEnriched.size>=DAILY_LIMIT){
    return NextResponse.json({error:"Daily HR contact enrichment limit reached. Try again tomorrow or increase DAILY_HR_ENRICHMENT_LIMIT.",limit:DAILY_LIMIT},{status:429});
  }

  const linkedin=await resolveCompanyLinkedIn(company.id);
  const decisionMakers=await findHrContacts(company.name,linkedin||company.linkedin_url);
  return NextResponse.json({job,company:{...company,linkedin_url:linkedin||company.linkedin_url||null},decisionMakers,source:"apify"});
 }catch(error){console.error("Selected job employee enrichment failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Unable to find HR contacts"},{status:500});}
}
