import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { createReadStream, existsSync } from "fs";
import { unlink, writeFile } from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

export async function GET() {
  const dbUrl = process.env.DATABASE_URL!;
  const outFile = path.join(os.tmpdir(), `finance-export-${Date.now()}.dump`);

  try {
    await execAsync(`pg_dump --format=custom --no-owner "${dbUrl}" -f "${outFile}"`);

    const stream = createReadStream(outFile);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);

    await unlink(outFile).catch(() => {});

    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="finance-${new Date().toISOString().slice(0, 10)}.dump"`,
      },
    });
  } catch (e: unknown) {
    await unlink(outFile).catch(() => {});
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
