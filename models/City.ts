import mongoose from "mongoose";

const citySchema = new mongoose.Schema(
  {
    region: String,
    cities: [
      {
        city_name: String,
        status: {
          type: String,
          enum: ["active", "inactive", "deleted"],
        },
        quick_wash:Boolean,
        pincode: Number,
        created_by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "employee",
        },
        updated_by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "employee",
        },
      },
    ],
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "employee",
    },
    status: {
      type: String,
      enum: ["active", "inactive", "deleted"],
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "employee",
    },
  },
  { timestamps: true }
);

export const City = mongoose.model("city", citySchema);
