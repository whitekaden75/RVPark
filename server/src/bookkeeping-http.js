// Express 4 does not forward rejected async handlers automatically.
export function bookkeepingRoutes(app) {
  return Object.fromEntries(['get','post','patch','delete'].map(method => [method,(path,...handlers) => app[method](path,...handlers.slice(0,-1),(req,res,next) => Promise.resolve().then(()=>handlers.at(-1)(req,res,next)).catch(error => {
    if(res.headersSent) return next?.(error);
    const schemaMissing=['42P01','42703'].includes(error.code);
    const conflict=['23503','23505','23514'].includes(error.code);
    return res.status(schemaMissing ? 503 : conflict ? 409 : error.statusCode || 500).json({message:schemaMissing ? 'Bookkeeping database setup is incomplete. Apply the bookkeeping migrations before using this feature.' : conflict ? 'This record is linked to a bill or consolidation. Unlink or restore it before changing its amount, type, currency, or status.' : error.message});
  }))]));
}
