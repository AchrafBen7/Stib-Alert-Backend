const v2 = {
    config: () => {},
    uploader: {
        upload: async () => ({ secure_url: "https://mock.cloudinary.com/test.jpg", public_id: "mock_id" }),
        destroy: async () => ({ result: "ok" }),
    },
};
module.exports = { v2 };
