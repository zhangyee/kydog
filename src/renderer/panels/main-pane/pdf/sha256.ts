/** 源 PDF 字节的 SHA-256（hex 小写）。用来判断译文边车是不是针对这一份 PDF 生成的（spec §5）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
