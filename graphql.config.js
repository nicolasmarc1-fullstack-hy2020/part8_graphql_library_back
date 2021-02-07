// graphql.config.js
module.exports = {
  projects: {
    app: {
      schema: ["index.js"],
      documents: ["**/*.{graphql,js,ts,jsx,tsx}", "my/fragments.graphql"],
    },
  },
}