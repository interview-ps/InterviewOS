export default {
  execute() {
    return { envKeys: Object.keys(process.env).sort() };
  },
};
