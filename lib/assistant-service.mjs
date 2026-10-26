import { randomBytes } from 'node:crypto';
import { validateAssistantPlan } from './assistant-planner.mjs';

export class AssistantServiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'AssistantServiceError'; this.code = code; this.status = status; }
}
const serviceError = (code, message, status) => { throw new AssistantServiceError(code, message, status); };
const validSession = session => typeof session === 'string' && session.length > 0 && session.length <= 256;
const positiveOutcome = value => value && typeof value === 'object' && value.ok === true && value.accepted === true
  && value.supported !== false && value.executed !== false;

/**
 * Optional contentAdapter must be { preview(action), execute(action, preview) }.
 * preview MUST be read-only and return {supported:true,...} only for a resolved supported request.
 * execute must return {ok:true,accepted:true,...}; accepting a launch is not proof of video playback.
 * A function-only adapter cannot guarantee a read-only preflight and is deliberately not called.
 */
export function createAssistantService({ control, planner, contentAdapter = null }) {
  const pending = new Map();
  let busy = false;
  const clean = () => { for (const [id, item] of pending) if (item.expires <= Date.now()) pending.delete(id); };
  const canResolveContent = contentAdapter && typeof contentAdapter.preview === 'function' && typeof contentAdapter.execute === 'function';
  const unsupportedResult = actions => ({ status: 'unsupported',
    reply: 'Vyhledání a spuštění této epizody zatím není ověřené. Žádnou TV akci jsem neprovedl.',
    completed: [], pending: actions, provider: 'codex' });

  async function contentPreviews(plan) {
    const previews = new Map();
    for (const [index, action] of plan.actions.entries()) {
      if (action.type !== 'search_content') continue;
      if (!canResolveContent) return null;
      let preview;
      try { preview = await contentAdapter.preview({ ...action }); } catch { return null; }
      if (!preview || preview.supported !== true || preview.ready === false || preview.executed === true) return null;
      previews.set(index, preview);
    }
    return previews;
  }

  async function execute(plan, previews) {
    const completed = [];
    for (const [index, action] of plan.actions.entries()) {
      let result;
      try {
        if (action.type === 'key') result = await control.key({ key: action.key });
        else if (action.type === 'launch_app') result = await control.launchApp({ appId: action.appId });
        else if (action.type === 'search_content' && canResolveContent && previews.has(index)) result = await contentAdapter.execute({ ...action }, previews.get(index));
        else throw new Error('Unsupported action');
        if (!positiveOutcome(result)) throw new Error('Action was not accepted');
      } catch {
        return { status: 'failed', reply: 'Povel se nepodařilo dokončit. Výsledek poslední akce není potvrzený.',
          completed, pending: plan.actions.slice(index), error: { code: 'action_not_accepted', message: 'Televize nebo přehrávač akci nepotvrdil.' }, provider: 'codex' };
      }
      completed.push({ type: action.type, result });
    }
    return { status: 'complete', reply: plan.reply, completed, pending: [], provider: 'codex' };
  }

  return {
    async request({ text, session }) {
      if (!validSession(session)) serviceError('session_required', 'Nejprve spárujte tuto obrazovku.', 401);
      if (typeof text !== 'string' || !text.trim() || text.length > 500) serviceError('invalid_input', 'Povel musí mít 1 až 500 znaků.');
      if (busy) serviceError('assistant_busy', 'Asistent právě dokončuje předchozí povel.', 429);
      busy = true;
      try {
        clean();
        const catalog = await control.listApps();
        const apps = catalog.apps.map(app => ({ appId: app.appId, label: app.name }));
        const plan = validateAssistantPlan(await planner({ text, apps }), apps);
        if (plan.actions.some(action => action.type === 'clarify')) return { status: 'needs_input', reply: plan.reply, completed: [], pending: plan.actions, provider: 'codex' };
        const previews = await contentPreviews(plan);
        if (previews === null) return unsupportedResult(plan.actions.filter(action => action.type === 'search_content'));
        if (plan.needsConfirmation) {
          if (pending.size >= 128) serviceError('confirmation_limit', 'Dokončete předchozí potvrzení nebo chvíli počkejte.', 429);
          const id = randomBytes(18).toString('base64url');
          pending.set(id, { plan, previews, session, expires: Date.now() + 120000 });
          const contents = [...previews.values()].map(preview => ({ title: preview.content?.title,
            episode: preview.content?.episode, availability: preview.content?.availability,
            playbackVerified: false }));
          return { status: 'confirmation', reply: plan.reply, confirmationId: id, contents, completed: [], provider: 'codex' };
        }
        return await execute(plan, previews);
      } finally { busy = false; }
    },
    async confirm({ id, session }) {
      clean();
      const request = pending.get(id);
      if (!validSession(session) || !request || request.session !== session) serviceError('confirmation_invalid', 'Potvrzení není platné nebo vypršelo.');
      // A busy rejection must not consume an unexecuted confirmation.
      if (busy) serviceError('assistant_busy', 'Asistent právě dokončuje předchozí povel.', 429);
      pending.delete(id);
      busy = true;
      try { return await execute(request.plan, request.previews); }
      finally { busy = false; }
    },
  };
}
