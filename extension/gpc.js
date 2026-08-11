(() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "globalPrivacyControl",
  );

  if (descriptor) return;

  Object.defineProperty(Navigator.prototype, "globalPrivacyControl", {
    configurable: true,
    enumerable: true,
    get: () => true,
  });
})();
