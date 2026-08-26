import { NextResponse } from "next/server";
import { findEmails } from "@/lib/contact-actors";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  await params;
  const body=await request.json();
  const urls=Array.isArray(body?.linkedinUrls)?body.linkedinUrls.filter((x:unknown):x is string=>typeof x==="string").slice(0,5):[];
  if(!urls.length)return NextResponse.json({error:"Select at least one person"},{status:400});
  if(Array.isArray(body?.linkedinUrls)&&body.linkedinUrls.length>5)return NextResponse.json({error:"You can select up to 5 people per job"},{status:400});
  const results=await findEmails(urls);
  return NextResponse.json({contacts:results});
 }catch(error){console.error("Selected contact email lookup failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Unable to find email addresses"},{status:500});}
}
