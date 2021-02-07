const {
  ApolloServer,
  UserInputError,
  AuthenticationError,
  gql,
} = require("apollo-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const config = require("./utils/config");

const Book = require("./models/book");
const Author = require("./models/author");
const User = require("./models/user");

const typeDefs = gql`
  type Author {
    name: String!
    id: ID!
    born: String
    bookCount: Int!
    books: [Book!]!
  }
  type Book {
    title: String!
    published: Int!
    author: Author!
    id: ID!
    genres: [String]!
  }
  type User {
    username: String!
    favoriteGenre: String!
    id: ID!
  }
  type Token {
    value: String!
  }
  type Query {
    bookCount: Int!
    authorCount: Int!
    allBooks(author: String, genre: String): [Book!]!
    allAuthors: [Author!]!
    me: User!
  }
  type Mutation {
    addBook(
      title: String!
      author: String!
      published: Int!
      genres: [String]!
    ): Book
    editAuthor(name: String!, setBornTo: Int!): Author
    createUser(username: String!, favoriteGenre: String!): User
    login(username: String!, password: String!): Token
  }
  type Subscription {
    bookAdded: Book!
  }
`;


const { PubSub } = require("apollo-server");
const pubsub = new PubSub();

const resolvers = {
  Query: {
    bookCount: async () => Book.collection.countDocuments,
    allBooks: async (parent, args) => {
      const filters = {};
      if (args.author) {
        const author = await Author.findOne({ name: args.author });
        filters.author = author._id;
      }
      if (args.genre) filters.genres = { $in: args.genre };
      return Book.find(filters).populate("author");
    },
    authorCount: async () => Author.collection.countDocuments,
    allAuthors: async () => {
      return Author.find({});
    },
    me: (root, args, context) => {
      const currentUser = context.currentUser;
      if (!currentUser) {
        throw new AuthenticationError("not authenticated");
      }
      return currentUser;
    },
  },
  Mutation: {
    createUser: async (root, args) => {
      const user = new User({
        username: args.username,
        favoriteGenre: args.favoriteGenre,
      });
      try {
        await user.save();
      } catch (error) {
        throw new UserInputError(error.message, {
          invalidArgs: args,
        });
      }
      return user;
    },
    login: async (root, args) => {
      const user = await User.findOne({ username: args.username });

      if (!user || args.password !== "secred") {
        throw new UserInputError("wrong credentials");
      }

      const userForToken = {
        username: user.username,
        id: user._id,
      };
      return { value: jwt.sign(userForToken, config.JWT_SECRET) };
    },
    addBook: async (parent, args, context) => {
      const currentUser = context.currentUser;
      if (!currentUser) {
        throw new AuthenticationError("not authenticated");
      }

      const addedBook = new Book({ ...args });
      try {
        const author =
          (await Author.findOne({ name: args.author })) ??
          new Author({ name: args.author, born: null });
        author.books = [...author.books, addedBook._id];
        addedBook.author = author._id;
        //  validate both models before saving any to the db
        // or check / repacle with transaction rollback?
        const errors = [];
        errors.push(addedBook.validateSync());
        errors.push(author.validateSync());
        errors.forEach((error) => {
          console.log(error);
          if (error) {
            throw new UserInputError(error.message, {
              invalidArgs: args,
            });
          }
        });

        await addedBook.save();
        await author.save();
      } catch (error) {
        throw new UserInputError(error.message, {
          invalidArgs: args,
        });
      }
      const response = addedBook.populate("author").execPopulate();
      pubsub.publish("BOOK_ADDED", { bookAdded: response });
      return response;
    },
    editAuthor: async (parent, args, context) => {
      // const editedAuthor = await Author.findOneAndUpdate(
      //   { name: args.name },
      //   { born: args.setBornTo },
      //   { new: true }
      // );
      const currentUser = context.currentUser;
      if (!currentUser) {
        throw new AuthenticationError("not authenticated");
      }
      const editedAuthor = await Author.findOne({ name: args.name });
      if (!editedAuthor) {
        throw new UserInputError("Author doesn't exist");
      }
      try {
        editedAuthor.born = args.setBornTo;
        await editedAuthor.save();
      } catch (error) {
        throw new UserInputError(error.message, {
          invalidArgs: args,
        });
      }
      return editedAuthor;
    },
  },
  Author: {
    bookCount: (parent) => {
      return parent.books.length;
    },
  },
  Subscription: {
    bookAdded: {
      subscribe: () => pubsub.asyncIterator(["BOOK_ADDED"]),
    },
  },
};

mongoose
  .connect(config.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,
    useCreateIndex: true,
  })
  .then(() => {
    console.log("connected to MongoDB");
  })
  .catch((error) => {
    console.log("error connection to MongoDB:", error.message);
  });

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: async ({ req }) => {
    const auth = req ? req.headers.authorization : null;
    if (auth && auth.toLowerCase().startsWith("bearer ")) {
      let currentUser;
      try {
        const decodedToken = jwt.verify(auth.substring(7), config.JWT_SECRET);
        currentUser = await User.findById(decodedToken.id);
      } catch (e) {
        currentUser = null;
      }
      return { currentUser };
    }
  },
});

server.listen().then(({ url }) => {
  console.log(`Server ready at ${url}`);
});

// # query {allAuthors {name, id, born, bookCount}}

// # # {"author":"Martin Fowler", "genre":"refactoring" }
// # query allBooks($author: String, $genre: String) {
// #   allBooks(author: $author, genre: $genre) {
// #     title
// #     published
// #     genres
// #     id
// #     author {name, id, born, bookCount}
// #   }
// # }

// # {"title": "Refactoring to patterns",
// #   "published": 2008,
// #   "author": "Joshua Kerievsky",
// #   "genres": ["refactoring", "patterns"]
// # }
// # mutation addBook(
// #   $title: String!
// #   $author: String!
// #   $published: Int!
// #   $genres: [String]!
// # ) {
// #   addBook(
// #     title: $title
// #     author: $author
// #     published: $published
// #     genres: $genres
// #   ) {
// #     title
// #   }
// # }

// # # {"name":"Martin Fowler", "setBornTo": 1963 }
// # mutation editAuthor($name: String!, $setBornTo: Int!) {
// #   editAuthor(name: $name, setBornTo: $setBornTo) {
// #     name
// #     id
// #     born
// #     bookCount
// #   }
// # }

// #
// # mutation {createUser(username:"test", favoriteGenre:"refactoring"){username}}
// # mutation {login(username:"test", password:"secred"){value}}
// # {"authorization": "bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6InRlc3QiLCJpZCI6IjVmYTA5YzZkNjcxYmZjZjk0ODU1MWIzMyIsImlhdCI6MTYwNDM2MTQ1OH0.Ww_aic-KJAZ-qAoisuiLsXaMvkRpnb6nOViLUKmElSc"}
// # query {me {username}}
