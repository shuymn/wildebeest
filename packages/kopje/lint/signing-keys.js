// Kopje signs a fetch as a local account only with a key chosen while the account is available (the Store's
// fetchSigner and its answers' fetch preparations, domain/actors.ts fetchSignerOf). localKey has no such check: only
// publishedKeyPair in federation.ts reads it, for the key pairs Fedify publishes, and nothing may make Fedify sign with
// those pairs. The root .oxlintrc.json turns this rule on for packages/kopje/src, and test-node/signing-keys.test.ts
// pins both the rule and that wiring.
const LOCAL_KEY = "Load a signing key with fetchSigner (it checks availability); localKey is publishedKeyPair's alone.";
const FEDIFY = "This makes Fedify sign with the published key pairs, which skip the availability check.";
const FEDIFY_NAMES = "/^(getDocumentLoader|getActorKeyPairs|setInboxListeners)$/";

const SELECTORS = {
  "MemberExpression:matches([property.name='localKey'], [property.value='localKey']):not(VariableDeclarator[id.name='publishedKeyPair'] MemberExpression)":
    LOCAL_KEY,
  "ObjectPattern > Property:matches([key.name='localKey'], [key.value='localKey'])": LOCAL_KEY,
  [`MemberExpression:matches([property.name=${FEDIFY_NAMES}], [property.value=${FEDIFY_NAMES}])`]: FEDIFY,
  [`ObjectPattern > Property:matches([key.name=${FEDIFY_NAMES}], [key.value=${FEDIFY_NAMES}])`]: FEDIFY,
};

export const signingKeys = {
  create(context) {
    return Object.fromEntries(
      Object.entries(SELECTORS).map(([selector, message]) => [selector, (node) => context.report({ node, message })]),
    );
  },
};

export default {
  meta: { name: "kopje" },
  rules: { "signing-keys": signingKeys },
};
