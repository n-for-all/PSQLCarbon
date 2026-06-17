module.exports = {
	apps: [
		{
			name: "PSQLCarbon",
			script: "npm",
			watch: false,
			args: "start",
			env: {
				PORT: 3000,
				NODE_ENV: "production",
			},
		},
	],
};
