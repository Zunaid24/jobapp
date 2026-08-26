import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { findHrContacts, resolveCompanyLinkedIn } from "@/lib/contact-actors";
function db(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error("Supabase configuration is missing");return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});}
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function POST(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params; const client=db();
  const {data:job,error}=await client.from("jobs").select("id,title,company,location,type,description,apply_url,posted_at,company_id").eq("id",id).maybeSingle();
  if(error)throw error;if(!job)return NextResponse.json({error:"Job not found"},{status:404});
  if(!job.company_id)return NextResponse.json({error:"This job has no company record"},{status:422});
  const {data:company}=await client.from("companies").select("id,name,website,domain,linkedin_url,location,industry,description").eq("id",job.company_id).maybeSingle();
  if(!company)return NextResponse.json({error:"Company not found"},{status:422});
  const linkedin=await resolveCompanyLinkedIn(company.id);
  const decisionMakers=await findHrContacts(company.name,linkedin||company.linkedin_url);
  return NextResponse.json({job,company:{...company,linkedin_url:linkedin||company.linkedin_url||null},decisionMakers});
 }catch(error){console.error("Selected job employee enrichment failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Unable to find HR contacts"},{status:500});}
}
