export type { XPageRequest, XPageControl, XPageObservation } from './xObservation';
export { collectXPage } from './xObservation';
export type { XPageNavigationProof, XSourceRootEnvelope } from './xDomSource';
export {
  xPageExpression,
  decodeXPage,
  bindXSourceRoot,
  admitXSourceRoot,
  xSourceRootReleaseExpression,
  sourceRootStateSchema,
  X_DOM_MAX_STRING_UNITS,
  X_DOM_MAX_QUERY_UNITS,
} from './xDomSource';
