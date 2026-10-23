import { expect, it } from "vitest";
import { recoverWritingFields, unwrapWritingJson } from "../src/main/writing-json";

const broken = '{"scenes":[{"title":"scene",{"type":"hint","value":"data"}}],"title":"标题","content":"原文","majorChange":false,"reason":""}';
it("isolates only the malformed optional metadata and retains the author decision", () => {
  const result = recoverWritingFields(broken.replace('"majorChange":false,"reason":""', '"majorChange":true,"reason":"修改结局"'));
  expect(result.omitted).toEqual(["scenes"]);
  expect(result.value).toEqual({title:"标题",content:"原文",majorChange:true,reason:"修改结局"});
});
it.each([
  broken + ',"majorChange":true',
  broken + '{"majorChange":true}',
  broken.replace('"content":"原文"','"content":"截断'),
  broken.replace('"title":"标题"','"title":"标题","title":"另一标题"'),
  broken.replace('"majorChange":false','"majorChange":maybe'),
  broken.replace('"scenes":[','"scenes":{'),
  broken.replace('"reason":""}', '"reason":"",}'),
  '{"title":"标题","content":"原文","scenes":[] "majorChange":true,"reason":"改结局"}',
  '{"title":"标题","content":"原文","scenes":[] "unknown":true}',
  '{"title":"标题","content":"原文","scenes":[] "title":"另一标题"}',
])("rejects incomplete, duplicated or ambiguous required data", raw => {
  expect(() => recoverWritingFields(raw)).toThrow();
});
it("keeps unknown root fields so that the domain parser can reject them", () => {
  const result = recoverWritingFields(broken.replace('"reason":""}', '"reason":"","unknown":true}'));
  expect(result.value.unknown).toBe(true);
});
it("leaves valid escaped backslashes and Chinese punctuation unchanged", () => {
  const value = { title:"引号", content:'他说：“保留\\“和\\”以及\\n。”', majorChange:false };
  expect(JSON.parse(unwrapWritingJson(JSON.stringify(value)))).toEqual(value);
});
it("does not repair arbitrary invalid JSON escapes", () => {
  expect(() => JSON.parse(unwrapWritingJson('{"content":"\\q"}'))).toThrow();
});
