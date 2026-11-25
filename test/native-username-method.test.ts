import {describe,it,expect} from "vitest";
import {generateKeyPairSync,sign} from "node:crypto";
import {verifyEntry} from "../src/core/accountRegistry.js";
import {assertFlowMethod,AccountMismatchError} from "../src/core/accountChoice.js";
import {cleanOptions} from "../src/core/signInMethod.js";
describe("ACCT-C15 signed username-method compatibility",()=>{
 it("verifies a native username signature, rejects tampering and incompatible platform flows",()=>{
  const service="fixture.example.test", account="fixture_user", at="2026-11-25T00:00:00Z";
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const sig=sign(null,Buffer.from(`account-authorization-v2|${service}|${account}|username|${at}`),privateKey).toString("base64url");
  const notes=`service=${service}\nsign_in_method=username\nissued_at=${at}\nauth_sig=${sig}`;
  const entry={name:`account-authorization/${service}`,notes,login:{username:account}};
  const pem=publicKey.export({type:"spki",format:"pem"}).toString();
  expect(verifyEntry(service,entry,pem)).toEqual({status:"authorized",service,account,signInMethod:"username"});
  expect(verifyEntry(service,{...entry,notes:notes.replace("sign_in_method=username","sign_in_method=email")},pem).status).toBe("tampered");
  expect(cleanOptions(["username","email"])).toEqual(["username","email"]);
  expect(()=>assertFlowMethod("fixture","username","email")).toThrow(AccountMismatchError);
  expect(()=>assertFlowMethod("fixture","username","google")).toThrow(AccountMismatchError);
 });
});
