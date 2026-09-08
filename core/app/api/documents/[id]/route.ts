import { getDocument } from "@/features/documents/server/service";
import { ApiError } from "@/lib/api-error";
import { requireOperator } from "@/server/auth/service";

/**
 * The bytes of one stored document, as a download — for the media gallery and
 * anyone the dashboard sends there. Not a JSON route: it answers the file
 * itself, so it authenticates the operator by hand and streams what the store
 * holds, whichever source keeps the row. A document keeps its bytes for good,
 * so the answer is immutable.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireOperator(request);
    const { id } = await context.params;
    const document = await getDocument(id);
    if (!document) return new Response("Not found", { status: 404 });
    const filename = (document.record.filename ?? `document.${document.format}`).replace(
      /["\r\n]/g,
      "_",
    );
    return new Response(new Uint8Array(document.bytes), {
      headers: {
        "content-type": document.record.mimeType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const apiError = err instanceof ApiError ? err : ApiError.internal("document read failed");
    return new Response(apiError.message, { status: apiError.status });
  }
}
